import { BadRequestException } from "@nestjs/common";
import type { AuthenticatedSocket } from "../../../auth/auth.types.js";
import type { WatchPartyService } from "../../watch-party.service.js";
import type { RealtimeContext } from "./realtime-context.js";

/** room:sync:pulse: owner playback commands, the Redis projection write and its repair. */
export class PlaybackSync {
    constructor(private readonly ctx: RealtimeContext) {}

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
            room = await this.ctx.watchPartyService.getRoomProjectionState(roomId);
        } catch (error) {
            this.ctx.logger.warn({
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
            const repaired = await this.ctx.redis.reconcileRoomState(
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
                this.ctx.logger.warn({
                    message:
                        "Playback projection repair was rejected; outbox reconciliation will converge it",
                    roomId,
                });
            }
        } catch (error) {
            this.ctx.logger.warn({
                message: "Playback projection repair failed",
                roomId,
                err: error,
            });
        }

        return true;
    }

    async handlePlaybackPulse(
        socket: AuthenticatedSocket,
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

        const metadata = this.ctx.registry.socketToParticipantMap.get(socket.id);

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
        const actor = this.ctx.registry.runningActors.get(metadata.roomId);

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
                projectionUpdated = await this.ctx.redis.updateRoomState(
                    metadata.roomCode,
                    {
                        status: updatedState.status,
                        playhead: updatedState.playhead,
                        lastUpdated: updatedState.lastUpdated,
                    },
                    metadata.roomId,
                );
            } catch (redisError) {
                this.ctx.logger.warn({
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

            this.ctx.server
                .to(metadata.roomId)
                .emit("room:sync:broadcast", broadcastPayload);

            /*
             * Pub/Sub is the synchronization event distribution
             * mechanism. It is NOT the room-state store. Best-effort: local clients
             * already received the broadcast above.
             */
            try {
                await this.ctx.redis.publicSyncPulse(
                    metadata.roomCode,
                    broadcastPayload,
                );
            } catch (publishError) {
                this.ctx.logger.warn({
                    message: "Failed to publish playback pulse to Redis",
                    roomId: metadata.roomId,
                    err: publishError,
                });
            }

            this.ctx.logger.log({
                message:
                    "Playback synchronization state change applied and broadcasted",
                roomId: metadata.roomId,
                action: data.action,
                playhead: updatedState.playhead,
                originatorId: user.id,
            });
        } catch (error) {
            this.ctx.logger.warn({
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
}
