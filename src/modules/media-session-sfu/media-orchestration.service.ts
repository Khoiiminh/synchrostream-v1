import {
    ConflictException,
    Injectable,
    NotFoundException,
} from "@nestjs/common";
import { MediaSessionService } from "./media-session.service.js";
import { SfuControlClient } from "@/shared/infrastructure/sfu/sfu-control.client.js";
import { MediaSession, SfuNodeStatus } from "./media-session.types.js";
import { MediaSessionRepository } from "./media-session.repository.js";
import { SfuSignalingTokenService } from "@/shared/infrastructure/sfu/sfu-signaling-token.service.js";
import { MediaSessionConnectionDto } from "./media-session.dto.js";

export interface SfuNode {
    id: string;
    nodeId: string;
    endpoint: string;
    signalingEndpoint: string;
    status: SfuNodeStatus;
    capacity: number;
    lastHeartbeatAt: Date | null;
}

@Injectable()
export class MediaOrchestrationService {
    constructor(
        private readonly repository: MediaSessionRepository,
        private readonly mediaSessionService: MediaSessionService,
        private readonly sfuControlClient: SfuControlClient,
        private readonly sfuSignalingTokenService: SfuSignalingTokenService,
    ) {}

    async createMediaSessionConnection(
        mediaSessionId: string,
        userId: string,
    ): Promise<MediaSessionConnectionDto> {
        const session =
            await this.mediaSessionService.getMediaSession(mediaSessionId);

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

        const participant = await this.repository.findRoomParticipant(
            session.roomId,
            userId,
        );

        if (!participant) {
            throw new NotFoundException(
                "The authenticated user is not a participant of the MediaSession room.",
            );
        }

        const node = await this.repository.findSfuNodeConnectionById(
            session.assignedSfuNodeId,
        );

        if (!node) {
            throw new NotFoundException(
                `Assigned SFU node ${session.assignedSfuNodeId} does not exist.`,
            );
        }

        if (node.status !== "HEALTHY" && node.status !== "DEGRADED") {
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

    async createMediaSession(roomId: string): Promise<MediaSession> {
        return this.mediaSessionService.createMediaSession(roomId);
    }

    async getMediaSessionByRoomId(roomId: string): Promise<MediaSession> {
        return this.mediaSessionService.getMediaSessionByRoomId(roomId);
    }

    async startMediaSession(mediaSessionId: string): Promise<MediaSession> {
        const session =
            await this.mediaSessionService.getMediaSession(mediaSessionId);

        if (session.status !== "CREATED") {
            throw new ConflictException(
                `MediaSession cannot start from status ${session.status}.`,
            );
        }

        const node = await this.selectSfuNode();

        const startingSession =
            await this.mediaSessionService.startMediaSession(mediaSessionId);

        const assignedSession =
            await this.mediaSessionService.assignMediaSession(
                startingSession.id,
                node.nodeId,
            );

        await this.sfuControlClient.createMediaSession(node.endpoint, {
            mediaSessionId: assignedSession.id,
            assignedSfuNodeId: node.nodeId,
        });

        return this.mediaSessionService.activateMediaSession(
            assignedSession.id,
        );
    }

    async selectSfuNode(): Promise<SfuNode> {
        const row = await this.repository.findBestAvailableSfuNode();

        if (!row) {
            throw new ConflictException(
                "No available SFU node is currently available.",
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
        const session =
            await this.mediaSessionService.getMediaSession(mediaSessionId);

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

        const node = await this.repository.findSfuNodeEndpointById(nodeId);

        if (!node) {
            throw new ConflictException(
                `Assigned SFU node ${nodeId} does not exist.`,
            );
        }

        await this.mediaSessionService.endMediaSession(mediaSessionId);

        await this.sfuControlClient.endMediaSession(
            node.endpoint,
            mediaSessionId,
        );

        return this.mediaSessionService.completeMediaSession(mediaSessionId);
    }
}
