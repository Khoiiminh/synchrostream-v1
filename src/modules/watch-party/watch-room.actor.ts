import { BadRequestException, Logger } from "@nestjs/common";

export interface ParticipantNode {
    participantId: string;
    userId: string;
    username: string;
    rtcIdentity: string;
    hasControlPrivilege: boolean;
    latencyScore: number;
}

export interface PlaybackState {
    playhead: number;
    status: 'PLAYING' | 'PAUSED';
    lastUpdated: number;
}

export class WatchRoomActor {
    private readonly logger = new Logger(WatchRoomActor.name);
    private readonly participants = new Map<string, ParticipantNode>();
    private playbackState: PlaybackState = { playhead: 0, status: 'PAUSED', lastUpdated: Date.now() };

    constructor(
        public readonly roomId: string,
        public readonly roomCode: string,
        public readonly passwordPlain: string,
        public readonly ownerId: string,
        public readonly movieId: string,
        public readonly maxParticipants: number,
    ) {}

    public getSnapshot() {
        return {
            roomId: this.roomId,
            roomCode: this.roomCode,
            passwordPlain: this.passwordPlain,
            ownerId: this.ownerId,
            moviedId:this.movieId,
            playback: { ...this.playbackState },
            occupancy: {
                current: this.participants.size,
                max: this.maxParticipants
            },
            members: Array.from(this.participants.values()),
        };
    }

    public registerParticipant(node: ParticipantNode): void {
        if (this.participants.size >= this.maxParticipants && this.participants.has(node.userId)) {
            this.logger.warn({ message: 'Participant registration blocked: Room capacity threshold violated', roomId: this.roomId, currentSize: this.participants.size, cap: this.maxParticipants, userId: node.userId });
            throw new BadRequestException(`Room capacity overflow limit reached. Cap: ${this.maxParticipants}`);
        }
        this.participants.set(node.userId, node);
    }

    public evictParticipantByUserId(userId: string): void {
        this.participants.delete(userId);
    }

    public getParticipantCount(): number {
        return this.participants.size;
    }

    public synchronizePlayback (p: {
        requestingId: string, 
        action: 'PLAY' | 'PAUSE' | 'SEEK',
        targetPlayhead: number
    }): PlaybackState {
        const actingMember = this.participants.get(p.requestingId);

        const isOwner = p.requestingId === this.ownerId;
        const hasPrivilege = actingMember?.hasControlPrivilege === true;

        if (!isOwner && !hasPrivilege) {
            this.logger.warn({ message: 'Playback transformation rule validation failed: Insufficient permissions framework', roomId: this.roomId, requestingId: p.requestingId, action: p.action });
            throw new BadRequestException('Action rejected: Insufficient track sync control privileges.');
        }

        this.playbackState = {
            playhead: p.targetPlayhead,
            status: p.action === 'PLAY' ? 'PLAYING' : p.action === 'PAUSE' ? 'PAUSED': this.playbackState.status,
            lastUpdated: Date.now(),
        };

        return this.playbackState;
    }

    public updateTelemetry(p: {userId: string, score: number}): void {
        const member = this.participants.get(p.userId);
        if (member) {
            member.latencyScore = p.score;
        }
    }
}