import type { AuthenticatedSocket } from "../../../auth/auth.types.js";
import type { WatchRoomActor } from "../../watch-room.actor.js";
import {
    GRACE_PERIOD_MS,
    PRESENCE_REFRESH_MS,
    PRESENCE_SWEEP_MS,
    PRESENCE_TTL_SECONDS,
    type BindingMetadata,
    type RealtimeContext,
} from "./realtime-context.js";

/**
 * Connection loss vs voluntary leave: the 10 s reconnection grace, owner
 * termination (with retry), participant expiry, the presence refresh and
 * sweeper, and immediate voluntary leave (decision record §3.1).
 */
export class MembershipLifecycle {
    private presenceRefreshTimer?: NodeJS.Timeout;
    private presenceSweepTimer?: NodeJS.Timeout;
    private presenceSweepRunning = false;

    constructor(private readonly ctx: RealtimeContext) {}

    /** Starts the presence refresh and sweep timers (gateway onModuleInit). */
    start(): void {
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

    /** Stops the timers and every pending grace cleanup (gateway onModuleDestroy). */
    stop(): void {
        if (this.presenceRefreshTimer) clearInterval(this.presenceRefreshTimer);
        if (this.presenceSweepTimer) clearInterval(this.presenceSweepTimer);
        for (const timeoutId of this.ctx.registry.pendingCleanups.values())
            clearTimeout(timeoutId);
    }

    private async refreshPresence(): Promise<void> {
        try {
            await this.ctx.redis.refreshPresence(
                this.ctx.registry.liveBindings(),
                PRESENCE_TTL_SECONDS,
            );
        } catch (error) {
            this.ctx.logger.warn({
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
                await this.ctx.watchPartyService.listActiveMemberships();
            const candidates = memberships.filter(
                (membership) =>
                    !this.ctx.registry.handshakesInFlight.has(membership.userId) &&
                    !this.ctx.registry.pendingCleanups.has(
                        this.ctx.registry.getCleanupKey(
                            membership.userId,
                            membership.roomId,
                        ),
                    ) &&
                    !this.ctx.registry.hasLiveBinding(membership.userId, membership.roomId),
            );
            if (candidates.length === 0) return;

            const presence = await this.ctx.redis.getPresence(candidates);
            const absent = candidates.filter((_, index) => !presence[index]);

            for (const membership of absent) {
                this.scheduleGraceCleanup(membership);
            }

            if (absent.length > 0) {
                this.ctx.logger.log({
                    message:
                        "Presence sweeper started grace cleanup for members without a live connection",
                    count: absent.length,
                });
            }
        } catch (error) {
            this.ctx.logger.warn({
                message: "Presence sweep skipped",
                err: error,
            });
        } finally {
            this.presenceSweepRunning = false;
        }
    }

    /** True when the user should be treated as present and not cleaned up. */
    async isUserPresent(
        userId: string,
        roomId: string,
    ): Promise<boolean> {
        if (this.ctx.registry.handshakesInFlight.has(userId)) return true;
        if (this.ctx.registry.hasLiveBinding(userId, roomId)) return true;
        try {
            const [present] = await this.ctx.redis.getPresence([
                { roomId, userId },
            ]);
            return present === true;
        } catch {
            // Presence unknown: cleanup proceeds on the local evidence, which is the
            // behaviour of the single-instance gateway.
            return false;
        }
    }

    async handleDisconnect(socket: AuthenticatedSocket): Promise<void> {
        const metadata = this.ctx.registry.socketToParticipantMap.get(socket.id);

        if (!metadata) {
            this.ctx.logger.debug({
                message:
                    "Anonymous or unauthenticated socket wire disconnected",
                socketId: socket.id,
            });

            return;
        }

        this.ctx.logger.warn({
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
        this.ctx.registry.socketToParticipantMap.delete(socket.id);

        // Without this, the presence key refreshed moments ago would make the grace
        // timer believe the user is still connected.
        if (!this.ctx.registry.hasLiveBinding(metadata.userId, metadata.roomId)) {
            try {
                await this.ctx.redis.clearPresence(
                    metadata.roomId,
                    metadata.userId,
                );
            } catch (error) {
                this.ctx.logger.warn({
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
    scheduleGraceCleanup(metadata: BindingMetadata): void {
        /*
         * Keep cleanup scoped to this user's membership in this specific room.
         * A new room must not cancel retries for an older room being terminated.
         */
        const cleanupKey = this.ctx.registry.getCleanupKey(metadata.userId, metadata.roomId);
        const existingCleanup = this.ctx.registry.pendingCleanups.get(cleanupKey);

        if (existingCleanup) {
            clearTimeout(existingCleanup);
            this.ctx.registry.pendingCleanups.delete(cleanupKey);
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
                            this.ctx.registry.pendingCleanups.get(cleanupKey);

                        if (currentCleanup !== cleanupTimeoutId) {
                            return;
                        }

                        this.ctx.registry.pendingCleanups.delete(cleanupKey);

                        // The user reconnected through another socket whose handshake ran
                        // while this disconnect was being processed, is reconnecting right
                        // now, or holds presence elsewhere. They are present.
                        if (
                            await this.isUserPresent(
                                metadata.userId,
                                metadata.roomId,
                            )
                        ) {
                            this.ctx.logger.log({
                                message:
                                    "Deferred cleanup skipped: user is still present",
                                roomId: metadata.roomId,
                                userId: metadata.userId,
                            });
                            return;
                        }

                        const actor = this.ctx.registry.runningActors.get(metadata.roomId);
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
                        this.ctx.logger.error({
                            message:
                                "Failed to complete deferred user disassociation routine",
                            participantId: metadata.participantId,
                            userId: metadata.userId,
                            roomId: metadata.roomId,
                            err: error,
                        });

                        const actor = this.ctx.registry.runningActors.get(metadata.roomId);
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

        this.ctx.registry.pendingCleanups.set(cleanupKey, cleanupTimeoutId);
    }

    private scheduleOwnerCleanupRetry(metadata: {
        participantId: string;
        roomId: string;
        roomCode: string;
        userId: string;
        isOwner: boolean;
    }): void {
        const cleanupKey = this.ctx.registry.getCleanupKey(metadata.userId, metadata.roomId);

        // Keep retrying failed owner cleanup instead of leaving an active room
        // permanently stuck after a transient LiveKit or database failure
        const retryTimeoutId = setTimeout(
            () =>
                void (async () => {
                    if (
                        this.ctx.registry.pendingCleanups.get(cleanupKey) !== retryTimeoutId
                    ) {
                        return;
                    }

                    this.ctx.registry.pendingCleanups.delete(cleanupKey);

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
                        this.ctx.logger.error({
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

        this.ctx.registry.pendingCleanups.set(cleanupKey, retryTimeoutId);
    }

    private async handleOwnerDisconnectCleanup(metadata: {
        participantId: string;
        roomId: string;
        roomCode: string;
        userId: string;
        isOwner: boolean;
    }): Promise<void> {
        this.ctx.logger.log({
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
        const result = await this.ctx.watchPartyService.leaveRoomSession(
            metadata.userId,
            metadata.roomId,
        );

        // The persistent room is now available to new joins. Notify and disconnect
        // current clients even if provider teardown needs a retry.
        this.ctx.server.to(metadata.roomId).emit("room:terminated", {
            message:
                "The room host has left the session. This watch room has been closed.",
        });

        const sockets = await this.ctx.server.in(metadata.roomId).fetchSockets();
        for (const clientSocket of sockets) {
            clientSocket.disconnect(true);
        }

        /*
         * The durable outbox completes media-provider teardown and projection cleanup.
         * The actor is no longer valid after termination begins.
         */
        this.ctx.registry.runningActors.delete(metadata.roomId);

        this.ctx.logger.log({
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
        this.ctx.logger.log({
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
        await this.ctx.watchPartyService.disassociateParticipant(
            metadata.participantId,
        );

        /*
         * Runtime lifecycle:
         *
         * Remove the user from the actor's active participant projection.
         */
        if (!actor) {
            this.ctx.logger.debug({
                message: "Room actor already absent during participant cleanup",
                roomId: metadata.roomId,
                userId: metadata.userId,
            });

            return;
        }

        actor.evictParticipantByUserId(metadata.userId);

        this.ctx.server.to(metadata.roomId).emit("room:member_left", {
            userId: metadata.userId,
        });

        const remainingCount = actor.getParticipantCount();

        this.ctx.logger.log({
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
            this.ctx.registry.runningActors.delete(metadata.roomId);

            this.ctx.logger.log({
                message:
                    "Actor context purged because room runtime occupancy reached zero",
                roomId: metadata.roomId,
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
        ] of this.ctx.registry.socketToParticipantMap.entries()) {
            if (metadata.userId === userId && metadata.roomId === roomId) {
                userSocketIds.push(socketId);
                this.ctx.registry.socketToParticipantMap.delete(socketId);
            }
        }
        if (requestingSocketId && !userSocketIds.includes(requestingSocketId)) {
            userSocketIds.push(requestingSocketId);
        }
        this.ctx.registry.cancelPendingCleanup(userId, roomId);
        try {
            await this.ctx.redis.clearPresence(roomId, userId);
        } catch (error) {
            // If cleanup below fails, an expired presence key lets the presence
            // sweeper fall back to the normal grace path; nothing is stranded.
            this.ctx.logger.warn({
                message: "Failed to clear presence during voluntary leave",
                roomId,
                userId,
                err: error,
            });
        }

        // 2. Authoritative state change (owner → TERMINATING, participant → inactive).
        const result = await this.ctx.watchPartyService.leaveRoomSession(
            userId,
            roomId,
        );
        const actor = this.ctx.registry.runningActors.get(roomId);

        // 3. Runtime fan-out to everyone else in the room.
        if (
            result.status === "ROOM_DESTROYED" ||
            result.status === "ROOM_ALREADY_TERMINATING"
        ) {
            this.ctx.server
                .to(roomId)
                .except(userSocketIds)
                .emit("room:terminated", {
                    message:
                        "The room host has left the session. This watch room has been closed.",
                });
            const sockets = await this.ctx.server.in(roomId).fetchSockets();
            for (const clientSocket of sockets) {
                if (!userSocketIds.includes(clientSocket.id))
                    clientSocket.disconnect(true);
            }
            this.ctx.registry.runningActors.delete(roomId);
        } else if (result.status === "PARTICIPANT_EVICTED") {
            actor?.evictParticipantByUserId(userId);
            this.ctx.server
                .to(roomId)
                .except(userSocketIds)
                .emit("room:member_left", { userId });
            if (actor && actor.getParticipantCount() === 0) {
                this.ctx.registry.runningActors.delete(roomId);
            }
        }

        // 4. The user's own sockets: the requester disconnects itself after the
        //    ack; any other tab of the same user is told it left and is closed.
        for (const socketId of userSocketIds) {
            const userSocket = this.ctx.server.sockets.get(socketId);
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

        this.ctx.logger.log({
            message: "Voluntary leave completed",
            userId,
            roomId,
            status: result.status,
        });

        return result.status;
    }

    async leaveRoom(
        socket: AuthenticatedSocket,
    ): Promise<{ ok: boolean; status?: string; message?: string }> {
        const user = socket.data.user;
        const metadata = this.ctx.registry.socketToParticipantMap.get(socket.id);

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
            this.ctx.logger.error({
                message:
                    "Voluntary leave failed; the client falls back to REST, then the grace path",
                userId: user.id,
                roomId: metadata.roomId,
                err: error,
            });
            return { ok: false, message: (error as Error).message };
        }
    }
}
