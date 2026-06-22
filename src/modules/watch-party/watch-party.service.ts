import { RedisProvider } from "@/shared/infrastructure/cache/redis.provider.js";
import { PostgresProvider } from "@/shared/infrastructure/database/postgres.provider.js";
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ApiProperty } from "@nestjs/swagger";

export class CreateRoomDto {
    @ApiProperty({ description: 'Explicit 6-character room tracking sequence code', example: 'A1B2C3' })
    roomCode!: string;

    @ApiProperty({ description: 'Plain text password constraint challenge signature', example: 'SecurePass123' })
    passwordPlain!: string;

    @ApiProperty({ description: 'The unique UUID matching the ingested target film entity' })
    movieId!: string;

    @ApiProperty({ description: 'Maximum participant threshold allocation', default: 5, required: false })
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

        const activeCheckQuery = 'SELECT id FROM rooms WHERE owner_id = $1 AND is_active = true';
        const [existingRoom] = await this.pg.query<any>(activeCheckQuery, [p.ownerId]);
        if (existingRoom) {
            this.logger.warn({ message: 'Failed room creation: User already possesses active session allocation', ownerId: p.ownerId, existingRoomId: existingRoom.id });
            throw new ConflictException('Active allocation conflict: Close running rooms before launching a new session.');
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
                    status: 'PAUSE',
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
            WHERE room_code = $1 AND is_active = true
        `;

        const [room] = await this.pg.query<any>(findRoomQuery, [p.dto.roomCode]);
        if (!room) {
            this.logger.warn({ message: 'Join room rejected: Active room code sequence not found', roomCode: p.dto.roomCode, userId: p.userId });
            throw new NotFoundException('Handshake rejected: No matching active room stream code sequence.');
        }

        if (room.password !== p.dto.passwordPlain) {
            this.logger.warn({ message: 'Join room security violation: Credentials challenge failed', roomCode: p.dto.roomCode, roomId: room.id, userId: p.userId });
            throw new BadRequestException('Security credentials verification failure: Authentication rejected.');
        }

        const isOwner = p.userId === room.owner_id;
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
}