import { BadRequestException, Logger, UseGuards } from "@nestjs/common";
import { ConnectedSocket, MessageBody, OnGatewayDisconnect, SubscribeMessage, WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { WatchRoomActor } from "./watch-room.actor.js";
import { JoinRoomDto, WatchPartyService } from "./watch-party.service.js";
import { RedisProvider } from "@/shared/infrastructure/cache/redis.provider.js";
import { WsJwtGuard } from "../auth/ws-jwt.guard.js";
import { MediaOrchestrationService } from "../media-session/media-orchestration.service.js";

@WebSocketGateway({
    namespace: 'sync-hub',
    cors: { origin: '*' }
})
export class WatchPartyGateway implements OnGatewayDisconnect {
    @WebSocketServer() server!: Server;
    private readonly logger = new Logger(WatchPartyGateway.name);

    private readonly runningActors = new Map<string, WatchRoomActor>();
    private readonly socketToParticipantMap = new Map<
        string, 
        { 
            participantId: string; 
            roomId: string; 
            roomCode: string; 
            userId: string 
        }>();

    private readonly pendingCleanups = new Map<string, NodeJS.Timeout>();

    constructor(
        private readonly watchPartyService: WatchPartyService,
        private readonly redis: RedisProvider,
        private readonly mediaOrchestrationService: MediaOrchestrationService,
    ) {}

    async handleDisconnect(socket: Socket): Promise<void> {
        const metadata = this.socketToParticipantMap.get(socket.id);

        if (!metadata) {
            this.logger.debug?.({
                message: 'Anonymous or unauthenticated socket wire disconnected',
                socketId: socket.id,
            });

            return;
        }

        this.logger.warn({
            message: 'Handshake link broken. Launching cleanup routines',
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

        /*
         * There can only be one pending cleanup for a user.
         *
         * If the user somehow has multiple stale sockets, cancel the old
         * cleanup before creating a new one.
         */
       const existingCleanup = this.pendingCleanups.get(metadata.userId);

        if (existingCleanup) {
            clearTimeout(existingCleanup);
            this.pendingCleanups.delete(metadata.userId);
        }

        const cleanupTimeoutId = setTimeout(async () => {
            try {
                /*
                 * The user may have reconnected after this timeout was
                 * scheduled. In that case the reconnect handler would have
                 * removed this user's entry from pendingCleanups.
                 *
                 * Therefore this timeout is no longer authoritative if the
                 * map no longer points to this exact timeout.
                 */
                const currentCleanup = this.pendingCleanups.get(
                    metadata.userId,
                );

                if (currentCleanup !== cleanupTimeoutId) {
                    return;
                }

                this.pendingCleanups.delete(metadata.userId);

                const actor = this.runningActors.get(metadata.roomId);

                /*
                 * IMPORTANT:
                 *
                 * Do not determine ownership from the participant record.
                 * The actor is the runtime representation of the room and
                 * already knows who the owner is.
                 */
                const isOwner =
                    actor !== undefined &&
                    actor.ownerId === metadata.userId;

                if (isOwner) {
                    await this.handleOwnerDisconnectCleanup(metadata, actor);
                } else {
                    await this.handleParticipantDisconnectCleanup(
                        metadata,
                        actor,
                    );
                }
            } catch (error) {
                this.logger.error({
                    message: 'Failed to complete deferred user disassociation routine',
                    participantId: metadata.participantId,
                    userId: metadata.userId,
                    roomId: metadata.roomId,
                    error: (error as Error).message,
                });
            }
        }, 10000);

        this.pendingCleanups.set(
            metadata.userId,
            cleanupTimeoutId,
        );
    }

    private async handleOwnerDisconnectCleanup(
        metadata: {
            participantId: string;
            roomId: string;
            roomCode: string;
            userId: string;
        },
        actor: WatchRoomActor,
    ): Promise<void> {
        this.logger.log({
            message: 'Owner grace period expired. Cleaning up entire room engine.',
            roomId: metadata.roomId,
            roomCode: metadata.roomCode,
            ownerId: metadata.userId,
        });

        /*
         * Notify everybody before the room is destroyed.
         */
        this.server
            .to(metadata.roomId)
            .emit('room:terminated', {
                message: 'The room host has left the session. This watch room has been closed.',
            });

        /*
         * The service owns persistent room cleanup:
         *
         * - rooms.is_active = false
         * - participant records removed
         * - Redis room state deleted
         */
        const result = await this.watchPartyService.leaveRoomSession(
            metadata.userId,
        );

        /*
         * The actor is no longer valid after the room has been destroyed.
         */
        this.runningActors.delete(metadata.roomId);

        /*
         * Disconnect every remaining socket in the room.
         */
        const sockets = await this.server
            .in(metadata.roomId)
            .fetchSockets();

        for (const clientSocket of sockets) {
            clientSocket.disconnect(true);
        }

        this.logger.log({
            message: 'Owner room cleanup completed',
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
            message: 'Participant grace period expired. Deactivating membership.',
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
            this.logger.debug?.({
                message: 'Room actor already absent during participant cleanup',
                roomId: metadata.roomId,
                userId: metadata.userId,
            });

            return;
        }

        actor.evictParticipantByUserId(metadata.userId);

        this.server
            .to(metadata.roomId)
            .emit('room:member_left', {
                userId: metadata.userId,
            });

        const remainingCount = actor.getParticipantCount();

        this.logger.log({
            message: 'Participant evicted from active room actor context',
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
                message: 'Actor context purged because room runtime occupancy reached zero',
                roomId: metadata.roomId,
            });
        }
    }

    @SubscribeMessage('room:connect')
    @UseGuards(WsJwtGuard)
    async handleConnectionHandshake(
        @ConnectedSocket() socket: Socket,
        @MessageBody() payload: { dto: JoinRoomDto }
    ) {
        const user = socket.data.user; 

        if (!user) {
            this.logger.warn({
                message:'Handshake context invalid: Missing credentials frame on socket data',
                socketId: socket.id,
            });

            throw new BadRequestException(
                'Handshake context invalid: Missing authorized credentials frame.',
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
        const pendingCleanup = this.pendingCleanups.get(user.id);

        if (pendingCleanup) {
            clearTimeout(pendingCleanup);
            this.pendingCleanups.delete(user.id);

            this.logger.log({
                message: 'User reconnected within grace window. Cancelled scheduled participant cleanup.',
                userId: user.id,
            });
        }

        this.logger.log({
            message: 'Processing room registration request',
            userId: user.id,
            roomCode: payload.dto?.roomCode,
        });

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
            const session =  await this.watchPartyService.associateParticipant({
                dto: payload.dto,
                userId: user.id,
            });

            /*
             * --------------------------------------------------------
             * MEDIA SESSION LIFECYCLE
             * --------------------------------------------------------
             */
            let mediaSession;

            try {
                mediaSession = await this.mediaOrchestrationService.getMediaSessionByRoomId(
                    session.roomId
                );

            } catch (error) {
                mediaSession = await this.mediaOrchestrationService.createMediaSession(
                    session.roomId,
                );

                mediaSession = await this.mediaOrchestrationService.startMediaSession(
                    mediaSession.id,
                );
            }

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
                    mediaSession.id,
                );

                /*
                 * The actor starts with default playback state.
                 *
                 * Before broadcasting its snapshot, restore playback
                 * state from Redis if one exists.
                 */
                const roomState =
                    await this.redis.getRoomState(session.roomCode);

                if (roomState.playhead !== undefined) {
                    const playhead = Number(roomState.playhead);

                    if (!Number.isNaN(playhead)) {
                        actor.synchronizePlayback({
                            requestingId: session.ownerId,
                            action:
                                roomState.status === 'PLAYING'
                                    ? 'PLAY'
                                    : 'PAUSE',
                            targetPlayhead: playhead,
                        });
                    }
                }

                this.runningActors.set(
                    session.roomId,
                    actor,
                );

                this.logger.log({
                    message: 'Spawning new room tracking actor dynamic context',
                    roomId: session.roomId,
                    roomCode: session.roomCode,
                });
            }

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
                    this.socketToParticipantMap.delete(existingSocketId);

                    this.logger.debug?.({
                        message: 'Removed stale socket binding during participant reconnection',
                        userId: user.id,
                        oldSocketId: existingSocketId,
                        newSocketId: socket.id,
                    });
                }
            }

            this.socketToParticipantMap.set(
                socket.id,
                {
                    participantId: session.participantId,
                    roomId: session.roomId,
                    roomCode: session.roomCode,
                    userId: user.id,
                },
            );

            await socket.join(session.roomId);

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
            const roomState =
                await this.redis.getRoomState(session.roomCode);

            if (!roomState.roomId) {
                await this.redis.setRoomState(
                    session.roomCode,
                    {
                        roomId: session.roomId,
                        roomCode: session.roomCode,
                        ownerId: session.ownerId,
                        movieId: session.movieId,
                        status: 'PAUSED',
                        playhead: '0',
                        lastUpdated: Date.now(),
                    },
                );
            }

            const snapshot = actor.getSnapshot();

            this.logger.log({
                message: 'Emitting room state snapshot',
                roomId: session.roomId,
                movieId: snapshot.movieId,
                mediaSessionId: snapshot.mediaSessionId,
            });

            this.server
                .to(session.roomId)
                .emit('room:state_update', snapshot);

            this.logger.log({
                message: 'Participant successfully bound to room pipeline',
                roomId: session.roomId,
                userId: user.id,
                participantId: session.participantId,
                socketId: socket.id,
            });
        } catch (error) {
            this.logger.warn({
                message:'Room connection enrollment failure intercepted',
                userId: user.id,
                roomCode: payload.dto?.roomCode,
                error: (error as Error).message,
            });

            socket.emit('room:error', {
                message: (error as Error).message,
            });

            socket.disconnect();
        }
    }

    @SubscribeMessage('room:sync:pulse')
    @UseGuards(WsJwtGuard)
    async handlePlaybackPulse(
        @ConnectedSocket() socket: Socket,
        @MessageBody() data: { 
            roomId: string; 
            roomCode: string; 
            action:'PLAY' | 'PAUSE' | 'SEEK'; 
            playhead: number 
        }
    ): Promise<void> {
        const user = socket.data.user;

        if (!user) {
            throw new BadRequestException(
                'Sync block transmission rejected: Context identity unverified.',
            );
        }

        const metadata = this.socketToParticipantMap.get(socket.id);

        if (!metadata) {
            throw new BadRequestException(
                'Playback pulse rejected: socket is not bound to a room.',
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
                'Synchronization step failure: State Actor target missing.',
            );
        }

        try {
            const updatedState = actor.synchronizePlayback({
                requestingId: user.id,
                action: data.action,
                targetPlayhead: data.playhead,
            });

            /*
             * Redis receives the latest durable room-state projection.
             *
             * Pub/Sub below is only the event channel.
             */
            await this.redis.updateRoomState(
                metadata.roomCode,
                {
                    status: updatedState.status,
                    playhead: updatedState.playhead,
                    lastUpdated: updatedState.lastUpdated,
                },
            );

            const broadcastPayload = {
                action: data.action,
                playhead: updatedState.playhead,
                originatorId: user.id,
                serverExecutionTime: updatedState.lastUpdated,
            };

            this.server
                .to(metadata.roomId)
                .emit(
                    'room:sync:broadcast',
                    broadcastPayload,
                );

            /*
             * Pub/Sub is the synchronization event distribution
             * mechanism. It is NOT the room-state store.
             */
            await this.redis.publicSyncPulse(
                metadata.roomCode,
                broadcastPayload,
            );

            this.logger.log({
                message: 'Playback synchronization state change applied and broadcasted',
                roomId: metadata.roomId,
                action: data.action,
                playhead: updatedState.playhead,
                originatorId: user.id,
            });
        } catch (error) {
            this.logger.warn({
                message: 'Sync operational request failed runtime execution check',
                roomId: metadata.roomId,
                requestingId: user.id,
                action: data.action,
                error: (error as Error).message,
            });

            socket.emit('room:error', {
                message: (error as Error).message,
            });
        }
    }

    @SubscribeMessage('room:chat:message')
    @UseGuards(WsJwtGuard)
    async handleChatMessage(
        @ConnectedSocket() socket: Socket,
        @MessageBody() data: { roomCode: string; message: string }
    ): Promise<void> {
        const user = socket.data.user;

        const targetMeta = this.socketToParticipantMap.get(socket.id);

        if (!user || !targetMeta) {
            throw new BadRequestException(
                'Message block transmission rejected: Context identity unverified.',
            );
        }

        this.logger.log({
            message: 'Inbound chat frame intercept received',
            roomCode: targetMeta.roomCode,
            userId: user.id,
        });

        this.server
            .to(targetMeta.roomId)
            .emit('room:chat:broadcast', {
                userId: user.id,
                username: user.username,
                message: data.message.trim(),
                timestamp: Date.now(),
            });
    }

    @SubscribeMessage('room:telemetry:ping')
    handleNetworkTelemetry(
        @ConnectedSocket() socket: Socket,
        @MessageBody() data: { 
            roomId: string; 
            userId: string; 
            clientTimestamp: number 
        }
    ): void {
        const user = socket.data.user;

        if (!user) {
            throw new BadRequestException(
                'Telemetry transmission rejected: Context identity unverified.',
            );
        }

        const metadata = this.socketToParticipantMap.get(socket.id);

        if (!metadata) {
            throw new BadRequestException(
                'Telemetry transmission rejected: socket is not bound to a room.',
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

        this.logger.debug?.({
            message: 'Network latency telemetry parsed',
            roomId: metadata.roomId,
            userId: user.id,
            computedRoundTripLatency,
        });

        socket.emit('room:telemetry:pong', {
            currentLatency: computedRoundTripLatency,
        });
    }
}