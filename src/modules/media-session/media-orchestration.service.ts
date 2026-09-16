import { PostgresProvider } from "@/shared/infrastructure/database/postgres.provider.js";
import { ConflictException, Injectable } from "@nestjs/common";
import { MediaSessionService } from "./media-session.service.js";
import { SfuControlClient } from "@/shared/infrastructure/sfu/sfu-control.client.js";
import { MediaSession } from "./media-session.types.js";

export interface SfuNode {
    id: string;
    nodeId: string;
    endpoint: string;
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
    ) {}

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