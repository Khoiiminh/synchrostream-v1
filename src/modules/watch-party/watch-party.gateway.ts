import {
    BadRequestException,
    HttpException,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
    UseGuards,
} from "@nestjs/common";
import {
    ConnectedSocket,
    MessageBody,
    OnGatewayDisconnect,
    SubscribeMessage,
    WebSocketGateway,
    WebSocketServer,
} from "@nestjs/websockets";
import { Namespace } from "socket.io";
import { WatchRoomActor } from "./watch-room.actor.js";
import { JoinRoomDto, WatchPartyService } from "./watch-party.service.js";
import { RedisProvider } from "@/shared/infrastructure/cache/redis.provider.js";
import { WsJwtGuard } from "../auth/guards/ws-jwt.guard.js";
import { LiveKitService } from "../livekit/livekit.service.js";
import type { AuthenticatedSocket } from "../auth/auth.types.js";

type BindingMetadata = {
    participantId: string;
    roomId: string;
    roomCode: string;
    userId: string;
    isOwner: boolean;
};

/** Reconnection grace before a disconnected member is cleaned up. */
const GRACE_PERIOD_MS = 10_000;
/** Presence keys outlive a missed refresh or two, then expire on their own. */
const PRESENCE_TTL_SECONDS = 30;
const PRESENCE_REFRESH_MS = 10_000;
/** How often active memberships without any presence are put into grace. */
const PRESENCE_SWEEP_MS = 15_000;

/*
 * Deployment note: runtime room state (actors, socket bindings, grace timers)
 * lives in this process and no Socket.IO adapter is configured, so the gateway
 * must run as a single instance. Redis presence keys keep the restart sweeper
 * safe, but broadcasts and actors are not shared across instances.
 */
@WebSocketGateway({
    namespace: "sync-hub",
    cors: { origin: "*" },
})
export class WatchPartyGateway
    implements OnGatewayDisconnect, OnModuleInit, OnModuleDestroy
{
    // With a gateway namespace, Nest injects the socket.io Namespace (not the root
    // Server). `server.sockets` is therefore the Map<socketId, Socket> itself.
    @WebSocketServer() server!: Namespace;
    private readonly logger = new Logger(WatchPartyGateway.name);

    private readonly runningActors = new Map<string, WatchRoomActor>();
    private readonly socketToParticipantMap = new Map<
        string,
        BindingMetadata
    >();

    private readonly pendingCleanups = new Map<string, NodeJS.Timeout>();

    // One background LiveKit startup loop per room; handshakes never wait on it.
    private readonly mediaSessionStartups = new Map<string, Promise<void>>();

    // Users with a room:connect handshake in progress. Cleanup never acts on
    // them: their membership is about to be (re)bound to a live socket.
    private readonly handshakesInFlight = new Map<string, number>();

    private presenceRefreshTimer?: NodeJS.Timeout;
    private presenceSweepTimer?: NodeJS.Timeout;
    private presenceSweepRunning = false;

    onModuleInit(): void {
        this.presenceRefreshTimer = setInterval(
            () => void this.refreshPresence(),
            PRESENCE_REFRESH_MS,
        );
        this.presenceRefreshTimer.unref?.();

        // Also covers backend restarts: memberships whose users never come back get
        // the normal grace period once their pre-restart presence keys expire.
        this.presenceSweepTimer = setInterval(
            () => void this.sweepAbsentMembers(),
            PRESENCE_SWEEP_MS,
        );
        this.presenceSweepTimer.unref?.();
    }

    onModuleDestroy(): void {
        if (this.presenceRefreshTimer) clearInterval(this.presenceRefreshTimer);
        if (this.presenceSweepTimer) clearInterval(this.presenceSweepTimer);
        for (const timeoutId of this.pendingCleanups.values())
            clearTimeout(timeoutId);
    }

    private beginHandshake(userId: string): void {
        this.handshakesInFlight.set(
            userId,
            (this.handshakesInFlight.get(userId) ?? 0) + 1,
        );
    }

    private endHandshake(userId: string): void {
        const remaining = (this.handshakesInFlight.get(userId) ?? 1) - 1;
        if (remaining > 0) this.handshakesInFlight.set(userId, remaining);
        else this.handshakesInFlight.delete(userId);
    }

    /** Bound sockets that are still connected, as presence entries. */
    private liveBindings(): BindingMetadata[] {
        const bindings: BindingMetadata[] = [];
        for (const [
            socketId,
            metadata,
        ] of this.socketToParticipantMap.entries()) {
            if (this.server?.sockets.get(socketId)?.connected)
                bindings.push(metadata);
        }
        return bindings;
    }

    private async refreshPresence(): Promise<void> {
        try {
            await this.redis.refreshPresence(
                this.liveBindings(),
                PRESENCE_TTL_SECONDS,
            );
        } catch (error) {
            this.logger.warn({
                message:
                    "Failed to refresh room presence; the sweeper skips rounds it cannot verify",
                err: error,
            });
        }
    }

    /**
     * Durable-state driven presence: any active membership of an ACTIVE room that
     * has no live socket here, no handshake in progress, no pending cleanup and
     * no presence key gets the normal grace period. When presence cannot be read
     * (Redis or PostgreSQL unavailable) the round is skipped, never guessed.
     */
    private async sweepAbsentMembers(): Promise<void> {
        if (this.presenceSweepRunning) return;
        this.presenceSweepRunning = true;
        try {
            const memberships =
                await this.watchPartyService.listActiveMemberships();
            const candidates = memberships.filter(
                (membership) =>
                    !this.handshakesInFlight.has(membership.userId) &&
                    !this.pendingCleanups.has(
                        this.getCleanupKey(
                            membership.userId,
                            membership.roomId,
                        ),
                    ) &&
                    !this.hasLiveBinding(membership.userId, membership.roomId),
            );
            if (candidates.length === 0) return;

            const presence = await this.redis.getPresence(candidates);
            const absent = candidates.filter((_, index) => !presence[index]);

            for (const membership of absent) {
                this.scheduleGraceCleanup(membership);
            }

            if (absent.length > 0) {
                this.logger.log({
                    message:
                        "Presence sweeper started grace cleanup for members without a live connection",
                    count: absent.length,
                });
            }
        } catch (error) {
            this.logger.warn({
                message: "Presence sweep skipped",
                err: error,
            });
        } finally {
            this.presenceSweepRunning = false;
        }
    }

    /** True when the user should be treated as present and not cleaned up. */
    private async isUserPresent(
        userId: string,
        roomId: string,
    ): Promise<boolean> {
        if (this.handshakesInFlight.has(userId)) return true;
        if (this.hasLiveBinding(userId, roomId)) return true;
        try {
            const [present] = await this.redis.getPresence([
                { roomId, userId },
            ]);
            return present === true;
        } catch {
            // Presence unknown: cleanup proceeds on the local evidence, which is the
            // behaviour of the single-instance gateway.
            return false;
        }
    }

    private getCleanupKey(userId: string, roomId: string): string {
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
    private hasLiveBinding(userId: string, roomId: string): boolean {
        let live = false;

        for (const [
            socketId,
            metadata,
        ] of this.socketToParticipantMap.entries()) {
            if (metadata.userId !== userId || metadata.roomId !== roomId)
                continue;

            if (this.server.sockets.get(socketId)?.connected) {
                live = true;
            } else {
                this.socketToParticipantMap.delete(socketId);
            }
        }

        return live;
    }

    private cancelPendingCleanup(userId: string, roomId: string): void {
        const cleanupKey = this.getCleanupKey(userId, roomId);
        const pendingCleanup = this.pendingCleanups.get(cleanupKey);

        if (pendingCleanup) {
            clearTimeout(pendingCleanup);
            this.pendingCleanups.delete(cleanupKey);
        }
    }

    /**
     * Ensures the room has an ACTIVE LiveKit media session without blocking
     * watch-room admission. Retries with capped backoff while the room actor is
     * alive and the room is ACTIVE, then pushes the session id to every member.
     */
    private ensureMediaSession(roomId: string): void {
        if (this.mediaSessionStartups.has(roomId)) return;

        const startup = (async () => {
            for (let attempt = 0; ; attempt += 1) {
                if (!this.runningActors.has(roomId)) return;

                try {
                    const mediaSession =
                        await this.liveKitService.getOrCreateMediaSession(
                            roomId,
                        );
                    const actor = this.runningActors.get(roomId);
                    if (!actor) return;

                    if (actor.mediaSessionId !== mediaSession.id) {
                        actor.setMediaSessionId(mediaSession.id);
                        this.server
                            .to(roomId)
                            .emit("room:state_update", actor.getSnapshot());
                    }
                    return;
                } catch (error) {
                    try {
                        await this.watchPartyService.assertRoomActive(roomId);
                    } catch {
                        // Termination owns provider cleanup; stop trying to start media.
                        return;
                    }

                    const delayMs = Math.min(
                        30_000,
                        1_000 * 2 ** Math.min(attempt, 5),
                    );
                    this.logger.warn({
                        message:
                            "LiveKit media session not ready; watch room stays available and startup will be retried",
                        roomId,
                        attempt: attempt + 1,
                        retryInMs: delayMs,
                        err: error,
                    });
                    await new Promise((resolve) =>
                        setTimeout(resolve, delayMs),
                    );
                }
            }
        })()
            .catch((error: unknown) => {
                this.logger.error({
                    message: "LiveKit media session startup loop failed",
                    roomId,
                    err: error,
                });
            })
            .finally(() => {
                this.mediaSessionStartups.delete(roomId);
            });

        this.mediaSessionStartups.set(roomId, startup);
    }

    constructor(
        private readonly watchPartyService: WatchPartyService,
        private readonly redis: RedisProvider,
        private readonly liveKitService: LiveKitService,
    ) {}

    async handleDisconnect(socket: AuthenticatedSocket): Promise<void> {
        const metadata = this.socketToParticipantMap.get(socket.id);

        if (!metadata) {
            this.logger.debug({
                message:
                    "Anonymous or unauthenticated socket wire disconnected",
                socketId: socket.id,
            });

            return;
        }

        this.logger.warn({
            message: "Handshake link broken. Launching cleanup routines",
            socketId: socket.id,
            ...metadata,
        });

        /*
         * The socket itself is gone, so its direct binding can be removed
         * immediately.
         *
         * The database participant record is intentionally NOT removed yet.
         * The user receives a 10-second reconnection grace period.
         */
        this.socketToParticipantMap.delete(socket.id);

        // Without this, the presence key refreshed moments ago would make the grace
        // timer believe the user is still connected.
        if (!this.hasLiveBinding(metadata.userId, metadata.roomId)) {
            try {
                await this.redis.clearPresence(
                    metadata.roomId,
                    metadata.userId,
                );
            } catch (error) {
                this.logger.warn({
                    message:
                        "Failed to clear presence on disconnect; it expires on its own",
                    roomId: metadata.roomId,
                    userId: metadata.userId,
                    err: error,
                });
            }
        }

        this.scheduleGraceCleanup(metadata);
    }

    /**
     * Starts (or restarts) the reconnection grace period for one membership.
     * Used for socket disconnects and for members the presence sweeper finds
     * without any live connection (for example after a backend restart).
     */
    private scheduleGraceCleanup(metadata: BindingMetadata): void {
        /*
         * Keep cleanup scoped to this user's membership in this specific room.
         * A new room must not cancel retries for an older room being terminated.
         */
        const cleanupKey = this.getCleanupKey(metadata.userId, metadata.roomId);
        const existingCleanup = this.pendingCleanups.get(cleanupKey);

        if (existingCleanup) {
            clearTimeout(existingCleanup);
            this.pendingCleanups.delete(cleanupKey);
        }

        const cleanupTimeoutId = setTimeout(
            () =>
                void (async () => {
                    try {
                        /*
                         * The user may have reconnected after this timeout was
                         * scheduled. In that case the reconnect handler would have
                         * removed this user's entry from pendingCleanups.
                         *
                         * Therefore this timeout is no longer authoritative if the
                         * map no longer points to this exact timeout.
                         */
                        const currentCleanup =
                            this.pendingCleanups.get(cleanupKey);

                        if (currentCleanup !== cleanupTimeoutId) {
                            return;
                        }

                        this.pendingCleanups.delete(cleanupKey);

                        // The user reconnected through another socket whose handshake ran
                        // while this disconnect was being processed, is reconnecting right
                        // now, or holds presence elsewhere. They are present.
                        if (
                            await this.isUserPresent(
                                metadata.userId,
                                metadata.roomId,
                            )
                        ) {
                            this.logger.log({
                                message:
                                    "Deferred cleanup skipped: user is still present",
                                roomId: metadata.roomId,
                                userId: metadata.userId,
                            });
                            return;
                        }

                        const actor = this.runningActors.get(metadata.roomId);
                        const isOwner =
                            metadata.isOwner ||
                            actor?.ownerId === metadata.userId;

                        if (isOwner) {
                            await this.handleOwnerDisconnectCleanup(metadata);
                        } else {
                            await this.handleParticipantDisconnectCleanup(
                                metadata,
                                actor,
                            );
                        }
                    } catch (error) {
                        this.logger.error({
                            message:
                                "Failed to complete deferred user disassociation routine",
                            participantId: metadata.participantId,
                            userId: metadata.userId,
                            roomId: metadata.roomId,
                            err: error,
                        });

                        const actor = this.runningActors.get(metadata.roomId);
                        if (
                            metadata.isOwner ||
                            actor?.ownerId === metadata.userId
                        ) {
                            this.scheduleOwnerCleanupRetry(metadata);
                        }
                    }
                })(),
            GRACE_PERIOD_MS,
        );

        this.pendingCleanups.set(cleanupKey, cleanupTimeoutId);
    }

    /**
     * Rebuilds the room's Redis projection, including the actor's playback
     * state, from authoritative PostgreSQL data after a rejected or failed
     * playback write (expired key, projection not yet ACTIVE, Redis error).
     * Returns false only when PostgreSQL says the room is no longer ACTIVE.
     */
    private async repairPlaybackProjection(
        roomId: string,
        playback: { status: string; playhead: number; lastUpdated: number },
    ): Promise<boolean> {
        let room: Awaited<
            ReturnType<WatchPartyService["getRoomProjectionState"]>
        >;
        try {
            room = await this.watchPartyService.getRoomProjectionState(roomId);
        } catch (error) {
            this.logger.warn({
                message:
                    "Could not read room state to repair the playback projection",
                roomId,
                err: error,
            });
            // Room state unknown: the actor only exists for bound members, so keep
            // the room usable rather than dropping the pulse.
            return true;
        }

        if (!room || room.lifecycleStatus !== "ACTIVE") return false;

        try {
            const repaired = await this.redis.reconcileRoomState(
                room.roomCode,
                {
                    roomId: room.roomId,
                    lifecycleVersion: room.stateVersion,
                    lifecycleStatus: room.lifecycleStatus,
                    roomCode: room.roomCode,
                    ownerId: room.ownerId,
                    movieId: room.movieId,
                    maxParticipants: room.maxParticipants,
                    participantCount: room.participantCount,
                    status: playback.status,
                    playhead: playback.playhead,
                    lastUpdated: playback.lastUpdated,
                },
            );
            if (!repaired) {
                this.logger.warn({
                    message:
                        "Playback projection repair was rejected; outbox reconciliation will converge it",
                    roomId,
                });
            }
        } catch (error) {
            this.logger.warn({
                message: "Playback projection repair failed",
                roomId,
                err: error,
            });
        }

        return true;
    }

    private scheduleOwnerCleanupRetry(metadata: {
        participantId: string;
        roomId: string;
        roomCode: string;
        userId: string;
        isOwner: boolean;
    }): void {
        const cleanupKey = this.getCleanupKey(metadata.userId, metadata.roomId);

        // Keep retrying failed owner cleanup instead of leaving an active room
        // permanently stuck after a transient LiveKit or database failure
        const retryTimeoutId = setTimeout(
            () =>
                void (async () => {
                    if (
                        this.pendingCleanups.get(cleanupKey) !== retryTimeoutId
                    ) {
                        return;
                    }

                    this.pendingCleanups.delete(cleanupKey);

                    if (
                        await this.isUserPresent(
                            metadata.userId,
                            metadata.roomId,
                        )
                    ) {
                        return;
                    }

                    try {
                        await this.handleOwnerDisconnectCleanup(metadata);
                    } catch (error) {
                        this.logger.error({
                            message:
                                "Owner room cleanup retry failed; scheduling another attempt",
                            roomId: metadata.roomId,
                            userId: metadata.userId,
                            err: error,
                        });
                        this.scheduleOwnerCleanupRetry(metadata);
                    }
                })(),
            5000,
        );

        this.pendingCleanups.set(cleanupKey, retryTimeoutId);
    }

    private async handleOwnerDisconnectCleanup(metadata: {
        participantId: string;
        roomId: string;
        roomCode: string;
        userId: string;
        isOwner: boolean;
    }): Promise<void> {
        this.logger.log({
            message:
                "Owner grace period expired. Cleaning up entire room engine.",
            roomId: metadata.roomId,
            roomCode: metadata.roomCode,
            ownerId: metadata.userId,
        });

        /*
         * Notify everybody before the room is destroyed.
         *
         * First make the room unavailable to new joins. Provider shutdown is a
         * separate operation and is retried if LiveKit is temporarily unavailable.
         */
        const result = await this.watchPartyService.leaveRoomSession(
            metadata.userId,
            metadata.roomId,
        );

        // The persistent room is now available to new joins. Notify and disconnect
        // current clients even if provider teardown needs a retry.
        this.server.to(metadata.roomId).emit("room:terminated", {
            message:
                "The room host has left the session. This watch room has been closed.",
        });

        const sockets = await this.server.in(metadata.roomId).fetchSockets();
        for (const clientSocket of sockets) {
            clientSocket.disconnect(true);
        }

        /*
         * The durable outbox completes media-provider teardown and projection cleanup.
         * The actor is no longer valid after termination begins.
         */
        this.runningActors.delete(metadata.roomId);

        this.logger.log({
            message: "Owner room cleanup completed",
            roomId: metadata.roomId,
            roomCode: metadata.roomCode,
            cleanupStatus: result.status,
        });
    }

    private async handleParticipantDisconnectCleanup(
        metadata: {
            participantId: string;
            roomId: string;
            roomCode: string;
            userId: string;
        },
        actor: WatchRoomActor | undefined,
    ): Promise<void> {
        this.logger.log({
            message:
                "Participant grace period expired. Deactivating membership.",
            roomId: metadata.roomId,
            roomCode: metadata.roomCode,
            userId: metadata.userId,
            participantId: metadata.participantId,
        });

        /*
         * Database lifecycle:
         *
         * The participant record is NOT deleted.
         * It is marked inactive and left_at is recorded.
         */
        await this.watchPartyService.disassociateParticipant(
            metadata.participantId,
        );

        /*
         * Runtime lifecycle:
         *
         * Remove the user from the actor's active participant projection.
         */
        if (!actor) {
            this.logger.debug({
                message: "Room actor already absent during participant cleanup",
                roomId: metadata.roomId,
                userId: metadata.userId,
            });

            return;
        }

        actor.evictParticipantByUserId(metadata.userId);

        this.server.to(metadata.roomId).emit("room:member_left", {
            userId: metadata.userId,
        });

        const remainingCount = actor.getParticipantCount();

        this.logger.log({
            message: "Participant evicted from active room actor context",
            roomId: metadata.roomId,
            userId: metadata.userId,
            remainingCount,
        });

        /*
         * Do NOT delete Redis room state here.
         *
         * The room still exists and the owner may still be watching.
         *
         * Redis room state represents the room, not an individual
         * participant membership.
         */

        /*
         * If nobody remains in the runtime actor, we can release the
         * in-memory actor.
         *
         * The persistent room itself is NOT destroyed here.
         */
        if (remainingCount === 0) {
            this.runningActors.delete(metadata.roomId);

            this.logger.log({
                message:
                    "Actor context purged because room runtime occupancy reached zero",
                roomId: metadata.roomId,
            });
        }
    }

    /** Extracts `{ code, roomId, roomCode, isOwner }` from a structured ConflictException. */
    private getConflictDetail(error: unknown): {
        code: string;
        roomId?: string;
        roomCode?: string;
        isOwner?: boolean;
    } | null {
        if (!(error instanceof HttpException)) return null;
        const body = error.getResponse() as { error?: unknown };
        const detail =
            typeof body === "object" && body !== null ? body.error : null;
        if (
            typeof detail !== "object" ||
            detail === null ||
            !("code" in detail)
        )
            return null;
        return detail as {
            code: string;
            roomId?: string;
            roomCode?: string;
            isOwner?: boolean;
        };
    }

    /**
     * Joins the target room. When the only obstacle is the user's membership in
     * another room and they confirmed the switch (`leaveCurrent`), leaves that
     * room voluntarily (closing it if they own it) and joins once more.
     * Credentials and capacity are validated before the conflict is raised, so
     * the user never leaves their room for a join that would fail anyway.
     */
    private async associateWithOptionalSwitch(
        dto: JoinRoomDto,
        userId: string,
        leaveCurrent: boolean,
    ): Promise<Awaited<ReturnType<WatchPartyService["associateParticipant"]>>> {
        try {
            return await this.watchPartyService.associateParticipant({
                dto,
                userId,
            });
        } catch (error) {
            const detail = this.getConflictDetail(error);
            if (
                !leaveCurrent ||
                detail?.code !== "ACTIVE_MEMBERSHIP_ELSEWHERE" ||
                !detail.roomId
            ) {
                throw error;
            }

            this.logger.log({
                message:
                    "Switching rooms: leaving the current room before joining the requested one",
                userId,
                leftRoomId: detail.roomId,
                targetRoomCode: dto.roomCode,
            });
            await this.leaveRoomVoluntarily(userId, detail.roomId);
            return await this.watchPartyService.associateParticipant({
                dto,
                userId,
            });
        }
    }

    /**
     * Voluntary leave: the user chose to leave, so there is no reconnection
     * grace. Cleanup runs immediately and the caller is answered only after the
     * database commit, so an immediate create/join elsewhere never hits a 409.
     *
     * Idempotent: a double click, a leave that races a disconnect, or a leave
     * arriving after grace cleanup already ran all resolve to a no-op status.
     */
    async leaveRoomVoluntarily(
        userId: string,
        roomId: string,
        requestingSocketId?: string,
    ): Promise<string> {
        // 1. Unbind first, so the disconnects that follow schedule no grace timer.
        const userSocketIds: string[] = [];
        for (const [
            socketId,
            metadata,
        ] of this.socketToParticipantMap.entries()) {
            if (metadata.userId === userId && metadata.roomId === roomId) {
                userSocketIds.push(socketId);
                this.socketToParticipantMap.delete(socketId);
            }
        }
        if (requestingSocketId && !userSocketIds.includes(requestingSocketId)) {
            userSocketIds.push(requestingSocketId);
        }
        this.cancelPendingCleanup(userId, roomId);
        try {
            await this.redis.clearPresence(roomId, userId);
        } catch (error) {
            // If cleanup below fails, an expired presence key lets the presence
            // sweeper fall back to the normal grace path; nothing is stranded.
            this.logger.warn({
                message: "Failed to clear presence during voluntary leave",
                roomId,
                userId,
                err: error,
            });
        }

        // 2. Authoritative state change (owner → TERMINATING, participant → inactive).
        const result = await this.watchPartyService.leaveRoomSession(
            userId,
            roomId,
        );
        const actor = this.runningActors.get(roomId);

        // 3. Runtime fan-out to everyone else in the room.
        if (
            result.status === "ROOM_DESTROYED" ||
            result.status === "ROOM_ALREADY_TERMINATING"
        ) {
            this.server
                .to(roomId)
                .except(userSocketIds)
                .emit("room:terminated", {
                    message:
                        "The room host has left the session. This watch room has been closed.",
                });
            const sockets = await this.server.in(roomId).fetchSockets();
            for (const clientSocket of sockets) {
                if (!userSocketIds.includes(clientSocket.id))
                    clientSocket.disconnect(true);
            }
            this.runningActors.delete(roomId);
        } else if (result.status === "PARTICIPANT_EVICTED") {
            actor?.evictParticipantByUserId(userId);
            this.server
                .to(roomId)
                .except(userSocketIds)
                .emit("room:member_left", { userId });
            if (actor && actor.getParticipantCount() === 0) {
                this.runningActors.delete(roomId);
            }
        }

        // 4. The user's own sockets: the requester disconnects itself after the
        //    ack; any other tab of the same user is told it left and is closed.
        for (const socketId of userSocketIds) {
            const userSocket = this.server.sockets.get(socketId);
            if (!userSocket) continue;
            void userSocket.leave(roomId);
            if (socketId !== requestingSocketId) {
                userSocket.emit("room:left", {
                    message:
                        "You left this watch room in another tab or window.",
                });
                userSocket.disconnect(true);
            }
        }

        this.logger.log({
            message: "Voluntary leave completed",
            userId,
            roomId,
            status: result.status,
        });

        return result.status;
    }

    @SubscribeMessage("room:leave")
    @UseGuards(WsJwtGuard)
    async handleLeaveRoom(
        @ConnectedSocket() socket: AuthenticatedSocket,
    ): Promise<{ ok: boolean; status?: string; message?: string }> {
        const user = socket.data.user;
        const metadata = this.socketToParticipantMap.get(socket.id);

        if (!user) {
            return {
                ok: false,
                message: "Leave rejected: socket is not authenticated.",
            };
        }
        if (!metadata) {
            // Already unbound (left elsewhere, or never fully joined): nothing to do here.
            return { ok: true, status: "NOT_BOUND" };
        }

        try {
            const status = await this.leaveRoomVoluntarily(
                user.id,
                metadata.roomId,
                socket.id,
            );
            return { ok: true, status };
        } catch (error) {
            this.logger.error({
                message:
                    "Voluntary leave failed; the client falls back to REST, then the grace path",
                userId: user.id,
                roomId: metadata.roomId,
                err: error,
            });
            return { ok: false, message: (error as Error).message };
        }
    }

    @SubscribeMessage("room:connect")
    @UseGuards(WsJwtGuard)
    async handleConnectionHandshake(
        @ConnectedSocket() socket: AuthenticatedSocket,
        @MessageBody() payload: { dto: JoinRoomDto; leaveCurrent?: boolean },
    ) {
        const user = socket.data.user;

        if (!user) {
            this.logger.warn({
                message:
                    "Handshake context invalid: Missing credentials frame on socket data",
                socketId: socket.id,
            });

            throw new BadRequestException(
                "Handshake context invalid: Missing authorized credentials frame.",
            );
        }

        /*
         * ------------------------------------------------------------
         * RECONNECTION GRACE
         * ------------------------------------------------------------
         *
         * If this user disconnected less than 10 seconds ago, cancel
         * their scheduled cleanup.
         *
         * The participant row remains active in PostgreSQL, so
         * associateParticipant() will reuse that same row.
         */
        this.logger.debug({
            message: "Processing room registration request",
            userId: user.id,
            roomCode: payload.dto?.roomCode,
        });

        let associatedSession:
            | Awaited<ReturnType<WatchPartyService["associateParticipant"]>>
            | undefined;
        let actorForCompensation: WatchRoomActor | undefined;
        let participantRegistered = false;
        let socketJoinedRoom = false;
        let roomEndedDuringHandshake = false;
        const staleSocketIds: string[] = [];

        this.beginHandshake(user.id);

        try {
            /*
             * --------------------------------------------------------
             * DATABASE PARTICIPANT LIFECYCLE
             * --------------------------------------------------------
             *
             * associateParticipant():
             *
             * - finds the active room
             * - verifies membership constraints
             * - reuses an active participant row on reconnect
             * - creates a NEW participant row for a genuinely new join
             */
            const session = (associatedSession =
                await this.associateWithOptionalSwitch(
                    payload.dto,
                    user.id,
                    payload.leaveCurrent === true,
                ));

            // Cancel the grace timer only after the credentials and membership have
            // been validated. If a later handshake stage fails, the catch path restores
            // disconnect cleanup for a reused membership.
            this.cancelPendingCleanup(user.id, session.roomId);

            /*
             * Media readiness does NOT gate watch-room admission. A LiveKit
             * startup conflict or outage must not disconnect the owner, because a
             * disconnected owner's grace expiry terminates the whole room. The
             * session is started in the background (ensureMediaSession below) and
             * pushed to members with room:state_update once ACTIVE.
             */
            await this.watchPartyService.assertRoomActive(session.roomId);

            /*
             * --------------------------------------------------------
             * RUNTIME ACTOR LIFECYCLE
             * --------------------------------------------------------
             *
             * The actor exists only while the room has active runtime
             * participants.
             *
             * If it was previously released because the room became
             * empty, create it again from authoritative room/session data.
             */
            let actor = this.runningActors.get(session.roomId);

            if (!actor) {
                actor = new WatchRoomActor(
                    session.roomId,
                    session.roomCode,
                    session.passwordPlain,
                    session.ownerId,
                    session.movieId,
                    session.maxParticipants,
                    null,
                );

                /*
                 * The actor starts with default playback state.
                 *
                 * Before broadcasting its snapshot, restore playback
                 * state from Redis if one exists.
                 */
                const roomState = await this.redis.getRoomState(
                    session.roomCode,
                );

                if (
                    roomState.roomId === session.roomId &&
                    roomState.lifecycleStatus === "ACTIVE" &&
                    roomState.playhead !== undefined
                ) {
                    const playhead = Number(roomState.playhead);

                    if (!Number.isNaN(playhead)) {
                        actor.synchronizePlayback({
                            requestingId: session.ownerId,
                            action:
                                roomState.status === "PLAYING"
                                    ? "PLAY"
                                    : "PAUSE",
                            targetPlayhead: playhead,
                        });
                    }
                }

                // A concurrent handshake for the same room may have created the actor
                // while this one awaited Redis. Keep the first one so no member's
                // registration is lost.
                const concurrentActor = this.runningActors.get(session.roomId);
                if (concurrentActor) {
                    actor = concurrentActor;
                } else {
                    this.runningActors.set(session.roomId, actor);

                    this.logger.log({
                        message:
                            "Spawning new room tracking actor dynamic context",
                        roomId: session.roomId,
                        roomCode: session.roomCode,
                    });
                }
            }

            actorForCompensation = actor;

            /*
             * --------------------------------------------------------
             * RUNTIME PARTICIPANT PROJECTION
             * --------------------------------------------------------
             *
             * No rtcIdentity.
             *
             * The database participantId identifies the persistent
             * membership record.
             *
             * userId identifies the runtime participant map entry.
             */
            actor.registerParticipant({
                participantId: session.participantId,
                userId: user.id,
                username: user.username,
                latencyScore: 0,
            });
            participantRegistered = true;

            /*
             * If the user already had another socket, replace its
             * socket binding.
             *
             * This matters because the old socket may have disappeared
             * while the user reconnects with a new Socket.IO connection.
             */
            for (const [
                existingSocketId,
                existingMetadata,
            ] of this.socketToParticipantMap.entries()) {
                if (
                    existingMetadata.userId === user.id &&
                    existingMetadata.roomId === session.roomId &&
                    existingSocketId !== socket.id
                ) {
                    staleSocketIds.push(existingSocketId);

                    this.logger.debug({
                        message:
                            "Removed stale socket binding during participant reconnection",
                        userId: user.id,
                        oldSocketId: existingSocketId,
                        newSocketId: socket.id,
                    });
                }
            }

            this.socketToParticipantMap.set(socket.id, {
                participantId: session.participantId,
                roomId: session.roomId,
                roomCode: session.roomCode,
                userId: user.id,
                isOwner: session.ownerId === user.id,
            });

            await socket.join(session.roomId);
            socketJoinedRoom = true;

            // The owner's termination may have committed and broadcast room:terminated
            // after the earlier active check but before this socket joined the room
            // channel. Re-check now that any later broadcast will reach this socket.
            try {
                await this.watchPartyService.assertRoomActive(session.roomId);
            } catch (inactiveError) {
                roomEndedDuringHandshake = true;
                throw inactiveError;
            }

            /*
             * --------------------------------------------------------
             * REDIS ROOM STATE
             * --------------------------------------------------------
             *
             * Do not recreate the room state blindly here.
             *
             * createRoomSession() already creates it.
             *
             * If it exists, preserve the current playback state.
             *
             * If it somehow does not exist, reconstruct the basic
             * room projection.
             */
            const roomState = await this.redis.getRoomState(session.roomCode);

            if (
                roomState.roomId !== session.roomId ||
                roomState.lifecycleStatus !== "ACTIVE"
            ) {
                const projected = await this.redis.reconcileRoomState(
                    session.roomCode,
                    {
                        roomId: session.roomId,
                        lifecycleVersion: session.lifecycleVersion,
                        lifecycleStatus: "ACTIVE",
                        roomCode: session.roomCode,
                        ownerId: session.ownerId,
                        movieId: session.movieId,
                        maxParticipants: session.maxParticipants,
                        participantCount: session.participantCount,
                        status: "PAUSED",
                        playhead: "0",
                        lastUpdated: Date.now(),
                    },
                );
                if (!projected) {
                    throw new BadRequestException(
                        "The room runtime projection belongs to a different lifecycle generation.",
                    );
                }
            }

            const snapshot = actor.getSnapshot();

            this.logger.debug({
                message: "Emitting room state snapshot",
                roomId: session.roomId,
                movieId: snapshot.movieId,
                mediaSessionId: snapshot.mediaSessionId,
            });

            this.server.to(session.roomId).emit("room:state_update", snapshot);

            this.logger.log({
                message: "Participant successfully bound to room pipeline",
                roomId: session.roomId,
                userId: user.id,
                participantId: session.participantId,
                socketId: socket.id,
            });

            for (const staleSocketId of staleSocketIds) {
                this.socketToParticipantMap.delete(staleSocketId);
                this.server.sockets.get(staleSocketId)?.disconnect(true);
            }

            // A stale socket's disconnect may have been processed during the awaits
            // above and scheduled a fresh grace timer. This socket is now bound, so
            // that timer is obsolete.
            this.cancelPendingCleanup(user.id, session.roomId);

            // Start (or confirm) the LiveKit session without blocking admission.
            // This also replaces a cached session id that is no longer ACTIVE.
            this.ensureMediaSession(session.roomId);

            try {
                await this.redis.refreshPresence(
                    [{ roomId: session.roomId, userId: user.id }],
                    PRESENCE_TTL_SECONDS,
                );
            } catch (presenceError) {
                this.logger.warn({
                    message:
                        "Failed to record presence after binding; the periodic refresh will retry",
                    roomId: session.roomId,
                    userId: user.id,
                    err: presenceError,
                });
            }
        } catch (error) {
            if (associatedSession) {
                const session = associatedSession;
                const cleanupKey = this.getCleanupKey(user.id, session.roomId);
                const hasOtherBoundSocket = Array.from(
                    this.socketToParticipantMap.entries(),
                ).some(([socketId, metadata]) => {
                    return (
                        socketId !== socket.id &&
                        metadata.userId === user.id &&
                        metadata.roomId === session.roomId
                    );
                });

                this.socketToParticipantMap.delete(socket.id);

                if (socketJoinedRoom) {
                    try {
                        await socket.leave(session.roomId);
                    } catch (leaveError) {
                        this.logger.warn({
                            message:
                                "Failed to remove socket from room after enrollment failure",
                            roomId: session.roomId,
                            socketId: socket.id,
                            err: leaveError,
                        });
                    }
                }

                if (
                    participantRegistered &&
                    actorForCompensation &&
                    !hasOtherBoundSocket
                ) {
                    actorForCompensation.evictParticipantByUserId(user.id);
                    if (actorForCompensation.getParticipantCount() === 0) {
                        this.runningActors.delete(session.roomId);
                    }
                }

                if (session.createdMembership && !hasOtherBoundSocket) {
                    try {
                        await this.watchPartyService.disassociateParticipant(
                            session.participantId,
                        );
                    } catch (compensationError) {
                        this.logger.error({
                            message:
                                "Failed to compensate participant membership after handshake failure",
                            participantId: session.participantId,
                            roomId: session.roomId,
                            userId: user.id,
                            err: compensationError,
                        });
                    }
                } else if (!session.createdMembership && !hasOtherBoundSocket) {
                    // The existing membership remains active for the grace window. Rebind
                    // metadata so disconnect handling schedules cleanup instead of orphaning it.
                    this.socketToParticipantMap.set(socket.id, {
                        participantId: session.participantId,
                        roomId: session.roomId,
                        roomCode: session.roomCode,
                        userId: user.id,
                        isOwner: session.ownerId === user.id,
                    });
                }

                // A failed handshake must not cancel the prior grace cleanup permanently.
                const pendingCleanup = this.pendingCleanups.get(cleanupKey);
                if (pendingCleanup && !session.createdMembership) {
                    clearTimeout(pendingCleanup);
                    this.pendingCleanups.delete(cleanupKey);
                }
            }

            this.logger.warn({
                message: "Room connection enrollment failure intercepted",
                userId: user.id,
                roomCode: payload.dto?.roomCode,
                err: error,
            });

            // Client 4xx outcomes (bad credentials, room not found, conflict, capacity)
            // will not change on retry. Anything else is an infrastructure failure the
            // client should retry promptly, before a reused membership's grace expires.
            const retryable = !(
                error instanceof HttpException && error.getStatus() < 500
            );

            if (roomEndedDuringHandshake) {
                // Same outcome the rest of the room received, so the client shows the
                // termination notice instead of a generic connection error.
                socket.emit("room:terminated", {
                    message:
                        "The room host has left the session. This watch room has been closed.",
                });
            } else {
                // Structured conflict detail (e.g. ACTIVE_MEMBERSHIP_ELSEWHERE) lets the
                // client offer "leave your current room and join this one".
                const detail = this.getConflictDetail(error);
                socket.emit("room:error", {
                    message: (error as Error).message,
                    retryable,
                    ...(detail
                        ? {
                              code: detail.code,
                              currentRoomCode: detail.roomCode,
                              currentRoomIsOwned: detail.isOwner,
                          }
                        : {}),
                });
            }

            socket.disconnect();
        } finally {
            this.endHandshake(user.id);
        }
    }

    @SubscribeMessage("room:sync:pulse")
    @UseGuards(WsJwtGuard)
    async handlePlaybackPulse(
        @ConnectedSocket() socket: AuthenticatedSocket,
        @MessageBody()
        data: {
            roomId: string;
            roomCode: string;
            action: "PLAY" | "PAUSE" | "SEEK";
            playhead: number;
        },
    ): Promise<void> {
        const user = socket.data.user;

        if (!user) {
            throw new BadRequestException(
                "Sync block transmission rejected: Context identity unverified.",
            );
        }

        const metadata = this.socketToParticipantMap.get(socket.id);

        if (!metadata) {
            throw new BadRequestException(
                "Playback pulse rejected: socket is not bound to a room.",
            );
        }

        /*
         * Never use roomId/roomCode from the client as the authoritative
         * room identity.
         *
         * socketToParticipantMap was established after authenticated
         * room association.
         */
        const actor = this.runningActors.get(metadata.roomId);

        if (!actor) {
            throw new BadRequestException(
                "Synchronization step failure: State Actor target missing.",
            );
        }

        try {
            const updatedState = actor.synchronizePlayback({
                requestingId: user.id,
                action: data.action,
                targetPlayhead: data.playhead,
            });

            /*
             * The actor is the runtime authority for playback; Redis is a
             * repairable projection used to restore a released actor. A projection
             * write that fails or is rejected must not silently drop the pulse
             * (clients would diverge from the actor), so it is repaired from
             * PostgreSQL and the pulse is still broadcast while the room is ACTIVE.
             */
            let projectionUpdated = false;
            try {
                projectionUpdated = await this.redis.updateRoomState(
                    metadata.roomCode,
                    {
                        status: updatedState.status,
                        playhead: updatedState.playhead,
                        lastUpdated: updatedState.lastUpdated,
                    },
                    metadata.roomId,
                );
            } catch (redisError) {
                this.logger.warn({
                    message:
                        "Playback projection write failed; broadcasting from the room actor",
                    roomId: metadata.roomId,
                    err: redisError,
                });
            }

            if (!projectionUpdated) {
                const roomStillActive = await this.repairPlaybackProjection(
                    metadata.roomId,
                    updatedState,
                );
                if (!roomStillActive) return;
            }

            const broadcastPayload = {
                action: data.action,
                playhead: updatedState.playhead,
                originatorId: user.id,
                serverExecutionTime: updatedState.lastUpdated,
            };

            this.server
                .to(metadata.roomId)
                .emit("room:sync:broadcast", broadcastPayload);

            /*
             * Pub/Sub is the synchronization event distribution
             * mechanism. It is NOT the room-state store. Best-effort: local clients
             * already received the broadcast above.
             */
            try {
                await this.redis.publicSyncPulse(
                    metadata.roomCode,
                    broadcastPayload,
                );
            } catch (publishError) {
                this.logger.warn({
                    message: "Failed to publish playback pulse to Redis",
                    roomId: metadata.roomId,
                    err: publishError,
                });
            }

            this.logger.log({
                message:
                    "Playback synchronization state change applied and broadcasted",
                roomId: metadata.roomId,
                action: data.action,
                playhead: updatedState.playhead,
                originatorId: user.id,
            });
        } catch (error) {
            this.logger.warn({
                message:
                    "Sync operational request failed runtime execution check",
                roomId: metadata.roomId,
                requestingId: user.id,
                action: data.action,
                err: error,
            });

            socket.emit("room:error", {
                message: (error as Error).message,
            });
        }
    }

    @SubscribeMessage("room:chat:message")
    @UseGuards(WsJwtGuard)
    handleChatMessage(
        @ConnectedSocket() socket: AuthenticatedSocket,
        @MessageBody() data: { roomCode: string; message: string },
    ): void {
        const user = socket.data.user;

        const targetMeta = this.socketToParticipantMap.get(socket.id);

        if (!user || !targetMeta) {
            throw new BadRequestException(
                "Message block transmission rejected: Context identity unverified.",
            );
        }

        this.logger.debug({
            message: "Inbound chat frame intercept received",
            roomCode: targetMeta.roomCode,
            userId: user.id,
        });

        this.server.to(targetMeta.roomId).emit("room:chat:broadcast", {
            userId: user.id,
            username: user.username,
            message: data.message.trim(),
            timestamp: Date.now(),
        });
    }

    /**
     * NTP-style clock probe used by clients to estimate their offset from the
     * server clock (the clock serverExecutionTime is stamped with). Answered via
     * the socket.io ack so the client can measure the round trip precisely.
     * Carries no room state, so it needs no room binding.
     */
    @SubscribeMessage("clock:sync")
    handleClockSync(
        @MessageBody() data: { clientSendTime?: number } | undefined,
    ): {
        clientSendTime: number | null;
        serverReceiveTime: number;
        serverSendTime: number;
    } {
        const serverReceiveTime = Date.now();
        const clientSendTime =
            typeof data?.clientSendTime === "number" &&
            Number.isFinite(data.clientSendTime)
                ? data.clientSendTime
                : null;

        return {
            clientSendTime,
            serverReceiveTime,
            serverSendTime: Date.now(),
        };
    }

    @SubscribeMessage("room:telemetry:ping")
    handleNetworkTelemetry(
        @ConnectedSocket() socket: AuthenticatedSocket,
        @MessageBody()
        data: {
            roomId: string;
            userId: string;
            clientTimestamp: number;
        },
    ): void {
        const user = socket.data.user;

        if (!user) {
            throw new BadRequestException(
                "Telemetry transmission rejected: Context identity unverified.",
            );
        }

        const metadata = this.socketToParticipantMap.get(socket.id);

        if (!metadata) {
            throw new BadRequestException(
                "Telemetry transmission rejected: socket is not bound to a room.",
            );
        }

        /*
         * Do not trust data.roomId or data.userId from the client.
         */
        const actor = this.runningActors.get(metadata.roomId);

        if (!actor) {
            return;
        }

        const computedRoundTripLatency = Date.now() - data.clientTimestamp;

        actor.updateTelemetry({
            userId: user.id,
            score: computedRoundTripLatency,
        });

        this.logger.debug({
            message: "Network latency telemetry parsed",
            roomId: metadata.roomId,
            userId: user.id,
            computedRoundTripLatency,
        });

        socket.emit("room:telemetry:pong", {
            currentLatency: computedRoundTripLatency,
        });
    }
}
