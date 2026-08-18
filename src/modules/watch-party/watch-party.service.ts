import { RedisProvider } from "@/shared/infrastructure/cache/redis.provider.js";
import { PostgresProvider } from "@/shared/infrastructure/database/postgres.provider.js";
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from "class-validator";

export class CreateRoomDto {
    @ApiProperty({ description: 'Explicit 6-character room tracking sequence code', example: 'A1B2C3' })
    @IsString()
    @Length(6, 6)
    roomCode!: string;

    @ApiProperty({ description: 'Plain text password constraint challenge signature', example: 'SecurePass123' })
    @IsString()
    passwordPlain!: string;

    @ApiProperty({ description: 'The unique UUID matching the ingested target film entity' })
    @IsUUID() // Explicitly enforce UUID format check if it matches database IDs
    @IsString()
    movieId!: string;

    @ApiProperty({ description: 'Maximum participant threshold allocation', default: 5, required: false })
    @IsOptional()
    @Type(() => Number) // FORCE execution transformation to cast incoming payload elements safely
    @IsInt()
    @Min(1)
    @Max(20)
    maxParticipants?: number;
}

export class JoinRoomDto {
    @ApiProperty({ description: 'Target 6-character room code to match against active sessions', example: 'A1B2C3' })
    roomCode!: string;

    @ApiProperty({ description: 'Plain text password entry to verify against target room authorization', example: 'SecurePass123' })
    passwordPlain!: string;
}

@Injectable()
export class WatchPartyService {
    private readonly logger = new Logger(WatchPartyService.name);

    constructor(
        private readonly pg: PostgresProvider,
        private readonly redis: RedisProvider,
    ) {}

    /** 
     * Initializes watch room settings within PostgreSQL using explicit DDL keys
     */
    async createRoomSession(p: {dto: CreateRoomDto, ownerId: string}) {
        this.logger.log({ message: 'Initiating session generation sequence for watch room', ownerId: p.ownerId, movieId: p.dto.movieId });

        // 1. Check if an active allocation exists for this user
        const activeCheckQuery = 'SELECT id FROM rooms WHERE owner_id = $1 AND is_active = true';
        const [existingRoom] = await this.pg.query<any>(activeCheckQuery, [p.ownerId]);

        if (existingRoom) {
            this.logger.warn({ 
                message: 'Overriding stale room session allocation detected during new creation request', 
                ownerId: p.ownerId, 
                staleRoomId: existingRoom.id,
                staleRoomCode: existingRoom.room_code
            });

            // 2. FORWARD-CLEANUP: Kill the ghost session immediately instead of failing!
            await this.pg.withTransaction(async (transactionClient) => {
                await transactionClient.query('UPDATE rooms SET is_active = false WHERE id = $1', [existingRoom.id]);
                await transactionClient.query('DELETE FROM room_participants WHERE room_id = $1', [existingRoom.id]);
            });
            
            // Wipe cache layer synchronously
            await this.redis.delRoomState(existingRoom.room_code);
        }

        try {
            return await this.pg.withTransaction(async (transactionClient) => {
                const insertRoomQuery = `
                    INSERT INTO public.rooms (room_code, "password", owner_id, movie_id, max_participants, is_active)
                    VALUES ($1, $2, $3, $4, $5, true)
                    RETURNING id, room_code, max_participants
                `;

                const roomResult = await transactionClient.query<any>(insertRoomQuery, [
                    p.dto.roomCode,
                    p.dto.passwordPlain,   
                    p.ownerId,
                    p.dto.movieId,
                    p.dto.maxParticipants || 5
                ]);

                const room = roomResult.rows[0];

                await this.redis.setRoomState(room.room_code, {
                    roomId: room.id,
                    roomCode: room.room_code,
                    ownerId: p.ownerId,
                    movieId: p.dto.movieId,
                    status: 'PAUSED',
                    playhead: '0',
                });
                
                this.logger.log({ message: 'Room session metadata committed to both persistent and cache storage layers', roomId: room.id, roomCode: room.room_code });

                return {
                    roomId: room.id,
                    roomCode: room.room_code,
                    maxParticipants: room.max_participants,
                };
            });
        } catch (error) {
            this.logger.error({ message: 'Failed transaction execution while creating room session', ownerId: p.ownerId, error: (error as Error).message }, (error as Error).stack);
            throw error;
        }
    }

    /**
     * Challenge routing verification matching table fields natively
     */
    async associateParticipant(p: {dto: JoinRoomDto, userId: string, rtcIdentity: string}) {
        const findRoomQuery = `
            SELECT id, room_code, "password", owner_id, movie_id, max_participants
            FROM rooms
            WHERE UPPER(TRIM(room_code)) = $1 AND is_active = true
        `;

        const cleanCode = p.dto.roomCode.trim().toUpperCase();
        const [room] = await this.pg.query<any>(findRoomQuery, [p.dto.roomCode]);
        if (!room) {
            this.logger.warn({ message: 'Join room rejected: Active room code sequence not found', roomCode: p.dto.roomCode, userId: p.userId });
            throw new NotFoundException('Handshake rejected: No matching active room stream code sequence.');
        }

        const isOwner = p.userId === room.owner_id;

        if (!isOwner && room.password !== p.dto.passwordPlain) {
            this.logger.warn({ message: 'Join room security violation: Credentials challenge failed', roomCode: cleanCode, roomId: room.id, userId: p.userId });
            throw new BadRequestException('Security credentials verification failure: Authentication rejected.');
        }

        const createParticipantQuery = `
            INSERT INTO room_participants (room_id, user_id, rtc_identity, has_control_privilege)
            VALUES ($1, $2, $3, $4)
            RETURNING id, room_id, has_control_privilege
        `;

        try {
            const [participant] = await this.pg.query<any>(createParticipantQuery, [
                room.id,
                p.userId,
                p.rtcIdentity,
                isOwner
            ]);

            this.logger.log({ message: 'Participant record successfully provisioned in DB', roomId: room.id, userId: p.userId, participantId: participant.id, isOwner });

            return {
                participantId: participant.id,
                roomId: room.id,
                roomCode: room.room_code,
                passwordPlain: room.password,
                movieId: room.movie_id,
                ownerId: room.owner_id,
                maxParticipants: room.max_participants,
                hasControlPrivilege: participant.has_control_privilege
            };
        } catch (error) {
            this.logger.error({ message: 'Database failure creating room participant tracking nodes', roomId: room.id, userId: p.userId, error: (error as Error).message });
            throw error;
        }
    }

    async disassociateParticipant(participantId: string): Promise<void> {
        try {
            await this.pg.query('DELETE FROM room_participants WHERE id = $1', [participantId]);
            this.logger.log({ message: 'Participant database node dropped successfully', participantId });
        } catch (error) {
            this.logger.error({ message: 'Failed to delete entry from room_participants relation matching identifier', participantId, error: (error as Error).message });
            throw error;
        }
    }

    async leaveRoomSession(userId: string): Promise<{ status: string; roomCode?: string; membersToKick?: string[] }> {
        const checkQuery = `
            SELECT r.id AS room_id, r.room_code, r.owner_id, rp.id AS participant_id
            FROM rooms r
            LEFT JOIN room_participants rp ON r.id = rp.room_id AND rp.user_id = $1
            WHERE (r.owner_id = $1 OR rp.user_id = $1) AND r.is_active = true
        `;

        const [userSession] = await this.pg.query<any>(checkQuery, [userId]);
        if (!userSession) {
            return { status: 'NO_ACTIVE_SESSION' };
        }

        const { room_id, room_code, owner_id } = userSession;

        if (owner_id === userId) {
            this.logger.log({ message: 'Owner disconnected. Cleaning up room engine entirely.', roomCode: room_code, ownerId: userId });

            // Fetch all current participants to notify them via gateway later
            const fetchMembersQuery = 'SELECT user_id FROM room_participants WHERE room_id = $1';
            const members = await this.pg.query<any>(fetchMembersQuery, [room_id]);
            const membersToKick = members.map((m: any) => m.user_id);

            await this.pg.withTransaction(async (transactionClient) => {
                // Mark the room as dead
                await transactionClient.query('UPDATE rooms SET is_active = false WHERE id = $1', [room_id]);
                // Delete participant entries to clean up constraints
                await transactionClient.query('DELETE FROM room_participants WHERE room_id = $1', [room_id]);
            });

            // Evict from Redis state completely
            await this.redis.delRoomState(room_code);

            return { status: 'ROOM_DESTROYED', roomCode: room_code, membersToKick };
        } else {
            // --- PARTICIPANT IS LEAVING: INDIVIDUAL REMOVAL ---
            this.logger.log({ message: 'Participant disconnected. Removing from tracking relation.', roomCode: room_code, userId });

            await this.pg.query(
                'DELETE FROM room_participants WHERE room_id = $1 AND user_id = $2', 
                [room_id, userId]
            );

            return { status: 'PARTICIPANT_EVICTED', roomCode: room_code };
        }
    }

    async getRoomDetailsByCode(roomCode: string) {
        const query = `
            SELECT 
                id AS "roomId",
                room_code AS "roomCode",
                owner_id AS "ownerId",
                movie_id AS "movieId",
                max_participants AS "maxParticipants",
                is_active AS "isActive"
            FROM public.rooms
            WHERE UPPER(TRIM(room_code)) = $1 AND is_active = true
        `;

        try {
            const cleanCode = roomCode.trim().toUpperCase();
            const [room] = await this.pg.query<any>(query, [cleanCode]);

            if (!room) {
                this.logger.warn({ 
                    message: 'Room lookup failed: Code not found or inactive', 
                    roomCode 
                });
                return null;
            }

            return room;
        } catch (error) {
            this.logger.error({ 
                message: 'Failed to execute room database lookup query', 
                roomCode, 
                error: (error as Error).message 
            });
            throw error;
        }
    }
}