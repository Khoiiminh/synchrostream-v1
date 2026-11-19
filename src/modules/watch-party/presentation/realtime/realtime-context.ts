import type { Logger } from "@nestjs/common";
import type { Namespace } from "socket.io";
import type { WatchRoomActor } from "../../watch-room.actor.js";
import type { WatchPartyService } from "../../watch-party.service.js";
import type { RoomChatRelay } from "../../room-chat.relay.js";
import type {
    MediaSessionPort,
    RealtimeStatePort,
} from "../../application/ports/collaborators.port.js";
import type { MembershipLifecycle } from "./membership-lifecycle.js";
import type { MediaStartup } from "./media-startup.js";
import type { ChatChannel } from "./chat-channel.js";
import type { PlaybackSync } from "./playback-sync.js";

export type BindingMetadata = {
    participantId: string;
    roomId: string;
    roomCode: string;
    userId: string;
    isOwner: boolean;
};

/** Reconnection grace before a disconnected member is cleaned up. */
export const GRACE_PERIOD_MS = 10_000;
/** Presence keys outlive a missed refresh or two, then expire on their own. */
export const PRESENCE_TTL_SECONDS = 30;
export const PRESENCE_REFRESH_MS = 10_000;
/** How often active memberships without any presence are put into grace. */
export const PRESENCE_SWEEP_MS = 15_000;

/**
 * The gateway's in-process room runtime: actors, socket bindings, grace
 * timers, media startups and in-flight handshakes. Moved out of the gateway
 * (phase 4). The deployment note on WatchPartyGateway applies: this state is
 * per process, so the gateway runs as a single instance.
 */
export class RoomRuntimeRegistry {
    readonly runningActors = new Map<string, WatchRoomActor>();
    readonly socketToParticipantMap = new Map<
        string,
        BindingMetadata
    >();

    readonly pendingCleanups = new Map<string, NodeJS.Timeout>();

    // One background LiveKit startup loop per room; handshakes never wait on it.
    readonly mediaSessionStartups = new Map<string, Promise<void>>();

    // Users with a room:connect handshake in progress. Cleanup never acts on
    // them: their membership is about to be (re)bound to a live socket.
    readonly handshakesInFlight = new Map<string, number>();

    /** `isConnected` answers whether a socket id is still connected. */
    constructor(private readonly isConnected: (socketId: string) => boolean) {}

    beginHandshake(userId: string): void {
        this.handshakesInFlight.set(
            userId,
            (this.handshakesInFlight.get(userId) ?? 0) + 1,
        );
    }

    endHandshake(userId: string): void {
        const remaining = (this.handshakesInFlight.get(userId) ?? 1) - 1;
        if (remaining > 0) this.handshakesInFlight.set(userId, remaining);
        else this.handshakesInFlight.delete(userId);
    }

    /** Bound sockets that are still connected, as presence entries. */
    liveBindings(): BindingMetadata[] {
        const bindings: BindingMetadata[] = [];
        for (const [
            socketId,
            metadata,
        ] of this.socketToParticipantMap.entries()) {
            if (this.isConnected(socketId))
                bindings.push(metadata);
        }
        return bindings;
    }

    getCleanupKey(userId: string, roomId: string): string {
        return `${userId}:${roomId}`;
    }

    /**
     * True when the user still has a connected socket bound to this room.
     *
     * A deferred cleanup must never act on a user who is currently connected:
     * an old socket's disconnect can be processed while a replacement socket is
     * mid-handshake, after that handshake already cancelled earlier timers.
     * Bindings whose socket is no longer connected are pruned here.
     */
    hasLiveBinding(userId: string, roomId: string): boolean {
        let live = false;

        for (const [
            socketId,
            metadata,
        ] of this.socketToParticipantMap.entries()) {
            if (metadata.userId !== userId || metadata.roomId !== roomId)
                continue;

            if (this.isConnected(socketId)) {
                live = true;
            } else {
                this.socketToParticipantMap.delete(socketId);
            }
        }

        return live;
    }

    cancelPendingCleanup(userId: string, roomId: string): void {
        const cleanupKey = this.getCleanupKey(userId, roomId);
        const pendingCleanup = this.pendingCleanups.get(cleanupKey);

        if (pendingCleanup) {
            clearTimeout(pendingCleanup);
            this.pendingCleanups.delete(cleanupKey);
        }
    }
}

/** What the realtime collaborators share. Built once by WatchPartyGateway. */
export interface RealtimeContext {
    /** The Socket.IO namespace; read lazily because Nest assigns it after construction. */
    readonly server: Namespace;
    readonly logger: Logger;
    readonly registry: RoomRuntimeRegistry;
    readonly watchPartyService: WatchPartyService;
    readonly redis: RealtimeStatePort;
    readonly liveKitService: MediaSessionPort;
    readonly chatRelay: RoomChatRelay;
    readonly lifecycle: MembershipLifecycle;
    readonly media: MediaStartup;
    readonly chat: ChatChannel;
    readonly playback: PlaybackSync;
}
