import { PostgresProvider } from "@/shared/infrastructure/database/postgres.provider.js";
import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { MediaSessionService } from "./media-session.service.js";
import { SfuControlClient } from "@/shared/infrastructure/sfu/sfu-control.client.js";
import { MediaSession } from "./media-session.types.js";
import { SfuSignalingTokenService } from "@/shared/infrastructure/sfu/sfu-signaling-token.service.js";
import { MediaSessionConnectionDto } from "./dto/media-session-connection.dto.js";

export interface SfuNode {
    id: string;
    nodeId: string;
    endpoint: string;
    signalingEndpoint: string;
    status: 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE';
    capacity: number;
    lastHeartbeatAt: Date | null;
}

@Injectable()
export class MediaOrchestrationService {
    constructor(
        private readonly pg: PostgresProvider,
        private readonly mediaSessionService: MediaSessionService,
        private readonly sfuControlClient: SfuControlClient,
        private readonly sfuSignalingTokenService: SfuSignalingTokenService,
    ) {}

    async createMediaSessionConnection(
        mediaSessionId: string,
        userId: string,
    ): Promise<MediaSessionConnectionDto>{
        const session = await this.mediaSessionService.getMediaSession(mediaSessionId);

        if (session.status !== "ACTIVE") {
            throw new ConflictException(
                `MediaSession cannot be connected from status ${session.status}.`,
            );
        }

        if (!session.assignedSfuNodeId) {
            throw new ConflictException(
                `MediaSession ${mediaSessionId} has no assigned SFU node.`,
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

        const [participant] = await this.pg.query<{
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

        if (!participant) {
            throw new NotFoundException(
                "The authenticated user is not a participant of the MediaSession room.",
            );
        }

        const nodeQuery = `
            SELECT
                id,
                node_id,
                endpoint,
                signaling_endpoint,
                status
            FROM public.sfu_nodes
            WHERE id = $1
            LIMIT 1
        `;

        const [node] = await this.pg.query<{
            id: string;
            node_id: string;
            endpoint: string;
            signaling_endpoint: string;
            status: "HEALTHY" | "DEGRADED" | "UNAVAILABLE";
        }>(
            nodeQuery,
            [session.assignedSfuNodeId],
        );

        if (!node) {
            throw new NotFoundException(
                `Assigned SFU node ${session.assignedSfuNodeId} does not exist.`,
            );
        }

        if (
            node.status !== "HEALTHY" &&
            node.status !== "DEGRADED"
        ) {
            throw new ConflictException(
                `Assigned SFU node ${node.node_id} is not available.`,
            );
        }

        const signalingToken = this.sfuSignalingTokenService.generateToken({
            sub: userId,
            mediaSessionId: session.id,
            participantId: participant.participant_id,
            nodeId: node.node_id,
        });

        return {
            mediaSessionId: session.id,
            participantId: participant.participant_id,
            sfuNodeId: node.node_id,
            signalingEndpoint: node.signaling_endpoint,
            signalingToken,
        };
    }

    async startMediaSession(mediaSessionId: string): Promise<MediaSession> {
        const session = await this.mediaSessionService.getMediaSession(mediaSessionId);

        if (session.status !== 'CREATED') {
            throw new ConflictException(
                `MediaSession cannot start from status ${session.status}.`,
            );
        }

        const node = await this.selectSfuNode();

        const startingSession = await this.mediaSessionService.startMediaSession(mediaSessionId);

        const assignedSession = await this.mediaSessionService.assignMediaSession(
            startingSession.id,
            node.nodeId,
        );

        await this.sfuControlClient.createMediaSession(
            node.endpoint,
            {
                mediaSessionId: assignedSession.id,
                assignedSfuNodeId: node.nodeId,
            },
        );

        return this.mediaSessionService.activateMediaSession(
            assignedSession.id,
        );
    }

    async selectSfuNode(): Promise<SfuNode> {
        const query = `
            SELECT 
                id,
                node_id,
                endpoint,
                signaling_endpoint,
                status,
                capacity,
                last_heartbeat_at
            FROM public.sfu_nodes
            WHERE status IN ('HEALTHY', 'DEGRADED')
            ORDER BY
                CASE
                    WHEN status = 'HEALTHY' THEN 0
                    ELSE 1
                END,
                capacity DESC,
                last_heartbeat_at DESC NULLS LAST
            LIMIT 1
        `;

        const [row] = await this.pg.query<{
            id: string;
            node_id: string;
            endpoint: string;
            signaling_endpoint: string;
            status: 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE';
            capacity: number;
            last_heartbeat_at: Date | null;
        }>(query);

        if (!row) {
            throw new ConflictException(
                'No available SFU node is currently available.',
            );
        }

        return {
            id: row.id,
            nodeId: row.node_id,
            endpoint: row.endpoint,
            signalingEndpoint: row.signaling_endpoint,
            status: row.status,
            capacity: row.capacity,
            lastHeartbeatAt: row.last_heartbeat_at,
        };
    }

    async endMediaSession(mediaSessionId: string): Promise<MediaSession> {
        const session = await this.mediaSessionService.getMediaSession(mediaSessionId);

        if (session.status !== "ACTIVE") {
            throw new ConflictException(
                `MediaSession cannot end from status ${session.status}.`,
            );
        }

        const nodeId = session.assignedSfuNodeId;

        if (!nodeId) {
            throw new ConflictException(
                `MediaSession ${mediaSessionId} has no assigned SFU node.`,
            );
        }

        const nodeQuery = `
            SELECT
                id,
                node_id,
                endpoint,
                status
            FROM public.sfu_nodes
            WHERE id = $1
            LIMIT 1
        `;

        const [node] = await this.pg.query<{
            id: string;
            node_id: string;
            endpoint: string;
            status: "HEALTHY" | "DEGRADED" | "UNAVAILABLE";
        }>(nodeQuery, [nodeId]);

        if (!node) {
            throw new ConflictException(
                `Assigned SFU node ${nodeId} does not exist.`,
            );
        }

        await this.mediaSessionService.endMediaSession(
            mediaSessionId,
        );

        await this.sfuControlClient.endMediaSession(
            node.endpoint,
            mediaSessionId,
        );

        return this.mediaSessionService.completeMediaSession(
            mediaSessionId,
        );
    }
}