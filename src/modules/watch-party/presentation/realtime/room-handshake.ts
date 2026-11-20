import { BadRequestException, HttpException } from "@nestjs/common";
import type { AuthenticatedSocket } from "@/shared/auth/auth-context.types.js";
import { WatchRoomActor } from "../../watch-room.actor.js";
import type {
    JoinRoomDto,
    WatchPartyService,
} from "../../watch-party.service.js";
import {
    PRESENCE_TTL_SECONDS,
    type RealtimeContext,
} from "./realtime-context.js";

/**
 * room:connect: membership (with the optional room switch), actor and
 * socket binding, projection check, and the compensation when any step fails.
 */
export class RoomHandshake {
    constructor(private readonly ctx: RealtimeContext) {}

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
            return await this.ctx.watchPartyService.associateParticipant({
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

            this.ctx.logger.log({
                message:
                    "Switching rooms: leaving the current room before joining the requested one",
                userId,
                leftRoomId: detail.roomId,
                targetRoomCode: dto.roomCode,
            });
            await this.ctx.lifecycle.leaveRoomVoluntarily(
                userId,
                detail.roomId,
            );
            return await this.ctx.watchPartyService.associateParticipant({
                dto,
                userId,
            });
        }
    }

    async handleConnectionHandshake(
        socket: AuthenticatedSocket,
        payload: { dto: JoinRoomDto; leaveCurrent?: boolean },
    ) {
        const user = socket.data.user;

        if (!user) {
            this.ctx.logger.warn({
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
        this.ctx.logger.debug({
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

        this.ctx.registry.beginHandshake(user.id);

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
            this.ctx.registry.cancelPendingCleanup(user.id, session.roomId);

            /*
             * Media readiness does NOT gate watch-room admission. A LiveKit
             * startup conflict or outage must not disconnect the owner, because a
             * disconnected owner's grace expiry terminates the whole room. The
             * session is started in the background (ensureMediaSession below) and
             * pushed to members with room:state_update once ACTIVE.
             */
            await this.ctx.watchPartyService.assertRoomActive(session.roomId);

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
            let actor = this.ctx.registry.runningActors.get(session.roomId);

            if (!actor) {
                actor = new WatchRoomActor(
                    session.roomId,
                    session.roomCode,
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
                const roomState = await this.ctx.redis.getRoomState(
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
                const concurrentActor = this.ctx.registry.runningActors.get(
                    session.roomId,
                );
                if (concurrentActor) {
                    actor = concurrentActor;
                } else {
                    this.ctx.registry.runningActors.set(session.roomId, actor);

                    this.ctx.logger.log({
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
            ] of this.ctx.registry.socketToParticipantMap.entries()) {
                if (
                    existingMetadata.userId === user.id &&
                    existingMetadata.roomId === session.roomId &&
                    existingSocketId !== socket.id
                ) {
                    staleSocketIds.push(existingSocketId);

                    this.ctx.logger.debug({
                        message:
                            "Removed stale socket binding during participant reconnection",
                        userId: user.id,
                        oldSocketId: existingSocketId,
                        newSocketId: socket.id,
                    });
                }
            }

            this.ctx.registry.socketToParticipantMap.set(socket.id, {
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
                await this.ctx.watchPartyService.assertRoomActive(
                    session.roomId,
                );
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
            const roomState = await this.ctx.redis.getRoomState(
                session.roomCode,
            );

            if (
                roomState.roomId !== session.roomId ||
                roomState.lifecycleStatus !== "ACTIVE"
            ) {
                const projected = await this.ctx.redis.reconcileRoomState(
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

            this.ctx.logger.debug({
                message: "Emitting room state snapshot",
                roomId: session.roomId,
                movieId: snapshot.movieId,
                mediaSessionId: snapshot.mediaSessionId,
            });

            this.ctx.server
                .to(session.roomId)
                .emit("room:state_update", snapshot);

            this.ctx.logger.log({
                message: "Participant successfully bound to room pipeline",
                roomId: session.roomId,
                userId: user.id,
                participantId: session.participantId,
                socketId: socket.id,
            });

            for (const staleSocketId of staleSocketIds) {
                this.ctx.registry.socketToParticipantMap.delete(staleSocketId);
                this.ctx.server.sockets.get(staleSocketId)?.disconnect(true);
            }

            // A stale socket's disconnect may have been processed during the awaits
            // above and scheduled a fresh grace timer. This socket is now bound, so
            // that timer is obsolete.
            this.ctx.registry.cancelPendingCleanup(user.id, session.roomId);

            // Start (or confirm) the LiveKit session without blocking admission.
            // This also replaces a cached session id that is no longer ACTIVE.
            this.ctx.media.ensureMediaSession(session.roomId);

            void this.ctx.chat.sendChatHistory(socket, session.roomId);

            try {
                await this.ctx.redis.refreshPresence(
                    [{ roomId: session.roomId, userId: user.id }],
                    PRESENCE_TTL_SECONDS,
                );
            } catch (presenceError) {
                this.ctx.logger.warn({
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
                const cleanupKey = this.ctx.registry.getCleanupKey(
                    user.id,
                    session.roomId,
                );
                const hasOtherBoundSocket = Array.from(
                    this.ctx.registry.socketToParticipantMap.entries(),
                ).some(([socketId, metadata]) => {
                    return (
                        socketId !== socket.id &&
                        metadata.userId === user.id &&
                        metadata.roomId === session.roomId
                    );
                });

                this.ctx.registry.socketToParticipantMap.delete(socket.id);

                if (socketJoinedRoom) {
                    try {
                        await socket.leave(session.roomId);
                    } catch (leaveError) {
                        this.ctx.logger.warn({
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
                        this.ctx.registry.runningActors.delete(session.roomId);
                    }
                }

                if (session.createdMembership && !hasOtherBoundSocket) {
                    try {
                        await this.ctx.watchPartyService.disassociateParticipant(
                            session.participantId,
                        );
                    } catch (compensationError) {
                        this.ctx.logger.error({
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
                    this.ctx.registry.socketToParticipantMap.set(socket.id, {
                        participantId: session.participantId,
                        roomId: session.roomId,
                        roomCode: session.roomCode,
                        userId: user.id,
                        isOwner: session.ownerId === user.id,
                    });
                }

                // A failed handshake must not cancel the prior grace cleanup permanently.
                const pendingCleanup =
                    this.ctx.registry.pendingCleanups.get(cleanupKey);
                if (pendingCleanup && !session.createdMembership) {
                    clearTimeout(pendingCleanup);
                    this.ctx.registry.pendingCleanups.delete(cleanupKey);
                }
            }

            this.ctx.logger.warn({
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
            this.ctx.registry.endHandshake(user.id);
        }
    }
}
