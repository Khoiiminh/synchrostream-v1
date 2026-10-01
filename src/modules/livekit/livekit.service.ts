import { PostgresProvider } from "@/shared/infrastructure/database/postgres.provider.js";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { MediaSessionService } from "../media-session-sfu/media-session.service.js";
import { LIVEKIT_CONFIG, type LiveKitConfig } from "@/shared/infrastructure/livekit/livekit.types.js";
import { LiveKitConnectionDto } from "./dto/livekit-connection.dto.js";
import { LiveKitTokenService } from "@/shared/infrastructure/livekit/livekit.token.service.js";
import { LiveKitInfrastructureService } from "@/shared/infrastructure/livekit/livekit.infrastructure.service.js";
import { MediaSession } from "../media-session-sfu/media-session.types.js";

@Injectable() 
export class LiveKitService {

    constructor(
        private readonly pg: PostgresProvider,
        private  readonly mediaSessionService: MediaSessionService,
        private readonly liveKitTokenService: LiveKitTokenService,
        private readonly liveKitInfrasService: LiveKitInfrastructureService,
        @Inject(LIVEKIT_CONFIG)
        private readonly liveKitConfig: LiveKitConfig,
    ) {}

    async createMediaSession(roomId: string): Promise<MediaSession> {
        const session = await this.mediaSessionService.createMediaSession(roomId);

        return await this.startMediaSession(session.id);
    }

    async createMediaSessionConnection(
        mediaSessionId: string, 
        userId: string
    ): Promise<LiveKitConnectionDto> {
        const session = await this.mediaSessionService.getMediaSession(mediaSessionId);

        if (session.status !== "ACTIVE") {
            throw new ConflictException(
                `MediaSession cannot be connected from status ${session.status}.`,
            );
        }

        const participantQuery = `
            SELECT
                rp.id AS participant_id,
                rp.user_id,
                rp.room_id
            FROM public.room_participants rp
            WHERE rp.room_id = $1
            AND rp.user_id = $2
            LIMIT 1
        `;

        const participant = await this.pg.query<{
            participant_id: string;
            user_id: string;
            room_id: string;
        }>(
            participantQuery,
            [
                session.roomId,
                userId,
            ],
        );

        if (!participant || participant.rows.length < 1) {
            throw new NotFoundException(
                "The authenticated user is not a participant of the MediaSession room.",
            );
        }

        const participantId = participant.rows[0].participant_id;

        const participantToken = await this.liveKitTokenService.createParticipantToken({
            roomName: session.id,
            participantIdentity: participantId,
            canPublish: true,
            canSubscribe: true,
            canPublishData: true,
        });
        
        return {
            mediaSessionId: session.id,
            participantId,
            serverUrl: this.liveKitConfig.url,
            participantToken,
        }
    }

    async startMediaSession(mediaSessionId: string): Promise<MediaSession> {
        const session = await this.mediaSessionService.getMediaSession(mediaSessionId);

        if (session.status !== 'CREATED') {
            throw new ConflictException(`MediaSession cannot start from status ${session.status}.`);
        }

        const roomQuery = `
            SELECT
                id,
                max_participants
            FROM public.rooms
            WHERE id = $1
            AND is_active = true
            LIMIT 1
        `;

        const room = await this.pg.query<{
            id: string;
            max_participants: number;
        }>(roomQuery, [session.roomId]);

        if (!room || room.rows.length < 1) {
            throw new NotFoundException(
                "The MediaSession watch room does not exist or is inactive."
            );
        }

        const startingSession = await this.mediaSessionService.startMediaSession(mediaSessionId);

        try {
            await this.liveKitInfrasService.createRoom(
                startingSession.id,
                room.rows[0].max_participants,
            );

            return await this.mediaSessionService.activateMediaSession(mediaSessionId);

        } catch (error) {
            throw error;
        }
    }
}