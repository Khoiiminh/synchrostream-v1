import { Logger } from "@nestjs/common";
import { hasCapacity } from "./domain/membership.js";
import {
    applyPlaybackCommand,
    initialPlaybackState,
    type PlaybackAction,
    type PlaybackState,
} from "./domain/playback.js";
import { PlaybackNotPermitted, RoomFull } from "./domain/errors.js";
import { toHttpException } from "./presentation/error-mapper.js";

export type { PlaybackState };

export interface ParticipantNode {
    participantId: string;
    userId: string;
    username: string;
    latencyScore: number;
}

// The actor is runtime state. PostgreSQL is persistence. Redis is shared runtime projection.
// Rules live in domain/; the actor still throws HTTP exceptions because the
// gateway's retryable/ack logic reads them (moves to the gateway in phase 4).

export class WatchRoomActor {
    private readonly logger = new Logger(WatchRoomActor.name);
    private readonly participants = new Map<string, ParticipantNode>();
    private playbackState: PlaybackState = initialPlaybackState(Date.now());

    // Media readiness is independent of watch-room admission: the actor may exist
    // before LiveKit is available, and the session may be replaced after recovery.
    private currentMediaSessionId: string | null;

    // Media readiness is independent of watch-room admission: the actor may exist
    // before LiveKit is available, and the session may be replaced after recovery.
    private currentMediaSessionId: string | null;

    constructor(
        public readonly roomId: string,
        public readonly roomCode: string,
        public readonly ownerId: string,
        public readonly movieId: string,
        public readonly maxParticipants: number,
        mediaSessionId: string | null,
    ) {
        this.currentMediaSessionId = mediaSessionId;
    }

    public get mediaSessionId(): string | null {
        return this.currentMediaSessionId;
    }

    public setMediaSessionId(mediaSessionId: string): void {
        this.currentMediaSessionId = mediaSessionId;
    }

    public getSnapshot() {
        return {
            roomId: this.roomId,
            roomCode: this.roomCode,
            ownerId: this.ownerId,
            movieId: this.movieId,
            mediaSessionId: this.currentMediaSessionId,
            playback: {
                ...this.playbackState,
            },
            occupancy: {
                current: this.participants.size,
                max: this.maxParticipants,
            },
            members: Array.from(this.participants.values()),
        };
    }

    public registerParticipant(node: ParticipantNode): void {
        const existingParticipant = this.participants.has(node.userId);

        // A reconnecting member keeps their slot even when the room is full.
        if (
            !existingParticipant &&
            !hasCapacity({
                activeCount: this.participants.size,
                capacity: this.maxParticipants,
            })
        ) {
            this.logger.warn({
                message:
                    "Participant registration blocked: Room capacity threshold violated",
                roomId: this.roomId,
                currentSize: this.participants.size,
                cap: this.maxParticipants,
                userId: node.userId,
            });

            throw toHttpException(new RoomFull(this.maxParticipants));
        }

        this.participants.set(node.userId, node);
    }

    public evictParticipantByUserId(userId: string): void {
        this.participants.delete(userId);
    }

    public getParticipantCount(): number {
        return this.participants.size;
    }

    public synchronizePlayback(p: {
        requestingId: string;
        action: PlaybackAction;
        targetPlayhead: number;
    }): PlaybackState {
        try {
            this.playbackState = applyPlaybackCommand(this.playbackState, {
                ...p,
                ownerId: this.ownerId,
                now: Date.now(),
            });
        } catch (error) {
            if (!(error instanceof PlaybackNotPermitted)) throw error;

            this.logger.warn({
                message:
                    "Playback command rejected: only the room owner has playback authority",
                roomId: this.roomId,
                requestingId: p.requestingId,
                ownerId: this.ownerId,
                action: p.action,
            });

            throw toHttpException(error);
        }

        return {
            ...this.playbackState,
        };
    }

    public updateTelemetry(p: { userId: string; score: number }): void {
        const member = this.participants.get(p.userId);

        if (member) {
            member.latencyScore = p.score;
        }
    }
}
