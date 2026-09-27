import { BadRequestException, Logger } from "@nestjs/common";

export interface ParticipantNode {
    participantId: string;
    userId: string;
    username: string;
    latencyScore: number;
}

export interface PlaybackState {
    playhead: number;
    status: 'PLAYING' | 'PAUSED';
    lastUpdated: number;
}

// The actor is runtime state. PostgreSQL is persistence. Redis is shared runtime projection.

export class WatchRoomActor {
    private readonly logger = new Logger(WatchRoomActor.name);
    private readonly participants = new Map<string, ParticipantNode>();
    private playbackState: PlaybackState = { 
        playhead: 0, 
        status: 'PAUSED', 
        lastUpdated: Date.now() 
    };

    constructor(
        public readonly roomId: string,
        public readonly roomCode: string,
        public readonly passwordPlain: string,
        public readonly ownerId: string,
        public readonly movieId: string,
        public readonly maxParticipants: number,
        public readonly mediaSessionId: string,
    ) {}

    public getSnapshot() {
        return {
            roomId: this.roomId,
            roomCode: this.roomCode,
            passwordPlain: this.passwordPlain,
            ownerId: this.ownerId,
            movieId:this.movieId,
            mediaSessionId: this.mediaSessionId,
            playback: { 
                ...this.playbackState 
            },
            occupancy: {
                current: this.participants.size,
                max: this.maxParticipants
            },
            members: Array.from(this.participants.values()),
        };
    }

    public registerParticipant(node: ParticipantNode): void {
        const existingParticipant = this.participants.has(node.userId);

        if (!existingParticipant && this.participants.size >= this.maxParticipants) {
            this.logger.warn({
                message: 'Participant registration blocked: Room capacity threshold violated',
                roomId: this.roomId,
                currentSize: this.participants.size,
                cap: this.maxParticipants,
                userId: node.userId,
            });

            throw new BadRequestException(`Room capacity overflow limit reached. Cap: ${this.maxParticipants}`);
        };

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
        const isOwner = p.requestingId === this.ownerId;

        if (!isOwner) {
            this.logger.warn({
                message: 'Playback command rejected: only the room owner has playback authority',
                roomId: this.roomId,
                requestingId: p.requestingId,
                ownerId: this.ownerId,
                action: p.action,
            });

            throw new BadRequestException(
                'Playback control rejected: only the room owner can control playback.'
            );
        }

        this.playbackState = {
            playhead: p.targetPlayhead,
            status:
            p.action === 'PLAY'
                ? 'PLAYING'
                : p.action === 'PAUSE'
                    ? 'PAUSED'
                    : this.playbackState.status,
            lastUpdated: Date.now(),
        }

        return {
            ...this.playbackState
        };
    }

    public updateTelemetry(p: {userId: string, score: number}): void {
        const member = this.participants.get(p.userId);

        if (member) {
            member.latencyScore = p.score;
        }
    }
}