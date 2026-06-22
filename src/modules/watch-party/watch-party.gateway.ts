import { BadRequestException, Logger, UseGuards } from "@nestjs/common";
import { ConnectedSocket, MessageBody, OnGatewayDisconnect, SubscribeMessage, WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { WatchRoomActor } from "./watch-room.actor.js";
import { JoinRoomDto, WatchPartyService } from "./watch-party.service.js";
import { RedisProvider } from "@/shared/infrastructure/cache/redis.provider.js";
import { WsJwtGuard } from "../auth/ws-jwt.guard.js";

@WebSocketGateway({
    namspace: 'sync-hub',
    cors: { origin: '*' }
})
export class WatchPartyGateway implements OnGatewayDisconnect {
    @WebSocketServer() server!: Server;
    private readonly logger = new Logger(WatchPartyGateway.name);

    private readonly runningActors = new Map<string, WatchRoomActor>();
    private readonly socketToParticipantMap = new Map<string, { participantId: string; roomId: string; roomCode: string; userId: string }>();

    constructor(
        private readonly watchPartyService: WatchPartyService,
        private readonly redis: RedisProvider,
    ) {}

    async handleDisconnect(socket: Socket) {
        const metadata = this.socketToParticipantMap.get(socket.id);
        if (!metadata) {
            this.logger.debug?.({ message: 'Anonymous or unauthenticated socket wire disconnected', socketId: socket.id });
            return;
        }

        this.logger.warn({ message: 'Handshake link broken. Launching cleanup routines', socketId: socket.id, ...metadata });

        try {
            await this.watchPartyService.disassociateParticipant(metadata.participantId);
        } catch (error) {
            this.logger.error({ message: 'Failed to disassociate participant from database store', participantId: metadata.participantId, error: (error as Error).message });
        }

        const actor = this.runningActors.get(metadata.roomId);
        if (actor) {
            actor.evictParticipantByUserId(metadata.userId);
            this.server.to(metadata.roomId).emit('room:member_left', { userId: metadata.userId });

            const remainingCount = actor.getParticipantCount();
            this.logger.log({ message: 'Evicted participant node from active room actor context', roomId: metadata.roomId, userId: metadata.userId, remainingCount });

            if (remainingCount === 0) {
                this.runningActors.delete(metadata.roomId);
                this.logger.log({ message: 'Actor context cleanly purged from runtime engine logs due to zero occupancy', roomId: metadata.roomId });
            }
        }

        this.socketToParticipantMap.delete(socket.id);
    }

    @SubscribeMessage('room:connect')
    @UseGuards(WsJwtGuard)
    async handleConnectionHandshake(
        @ConnectedSocket() socket: Socket,
        @MessageBody() payload: { dto: JoinRoomDto; rtcIdentity: string }
    ) {
        const user = socket.data.user; 
        if (!user) {
            this.logger.warn({ message: 'Handshake context invalid: Missing credentials frame on socket data', socketId: socket.id });
            throw new BadRequestException('Handshake context invalid: Missing authorized credentials frame.');
        }

        this.logger.log({ message: 'Processing room registration request', userId: user.id, roomCode: payload.dto?.roomCode });

        try {
            const session = await this.watchPartyService.associateParticipant({ dto: payload.dto, userId: user.id, rtcIdentity: payload.rtcIdentity });

            let actor = this.runningActors.get(session.roomId);
            if (!actor) {
                actor = new WatchRoomActor(
                    session.roomId,
                    session.roomCode,
                    session.ownerId,
                    session.movieId,
                    session.maxParticipants,
                );
                this.runningActors.set(session.roomId, actor);
                this.logger.log({ message: 'Spawning new room tracking actor dynamic context', roomId: session.roomId, roomCode: session.roomCode });
            }

            actor.registerParticipant({
                participantId: session.participantId,
                userId: user.id,
                username: user.username,
                rtcIdentity: payload.rtcIdentity,
                hasControlPrivilege: session.hasControlPrivilege,
                latencyScore: 0
            });

            this.socketToParticipantMap.set(socket.id, {
                participantId: session.participantId,
                roomId: session.roomId,
                roomCode: session.roomCode,
                userId: user.id
            });

            await socket.join(session.roomId);
            this.server.to(session.roomId).emit('room:state_update', actor.getSnapshot());
            
            this.logger.log({ message: 'Participant successfully bound to room pipeline', roomId: session.roomId, userId: user.id, socketId: socket.id });
        } catch (error) {
            this.logger.warn({ message: 'Room connection enrollment failure intercepted', userId: user.id, roomCode: payload.dto?.roomCode, error: (error as Error).message });
            socket.emit('room:error', { message: (error as Error).message });
            socket.disconnect();
        }
    }

    @SubscribeMessage('room:sync:pulse')
    async handlePlaybackPulse(
        @ConnectedSocket() socket: Socket,
        @MessageBody() data: { roomId: string; roomCode: string; userId: string; action:'PLAY' | 'PAUSE' | 'SEEK'; playhead: number }
    ) {
        const actor = this.runningActors.get(data.roomId);
        if (!actor) {
            this.logger.warn({ message: 'Sync command rejected: State Actor target absent', roomId: data.roomId, requestingId: data.userId });
            throw new BadRequestException('Synchronization step failure: State Actor target missing.');
        }

        try {
            const updatedState = actor.synchronizePlayback({
                requestingId: data.userId, 
                action: data.action, 
                targetPlayhead: data.playhead
            });

            const broadcastPayload = {
                action: data.action,
                playhead: updatedState.playhead,
                originatorId: data.userId,
                serverExecutionTime: updatedState.lastUpdated
            };

            this.server.to(data.roomId).emit('room:sync:broadcast', broadcastPayload);
            await this.redis.publicSyncPulse(data.roomCode, broadcastPayload);

            this.logger.log({ 
                message: 'Playback synchronization state change applied and broadcasted', 
                roomId: data.roomId, 
                action: data.action, 
                playhead: data.playhead, 
                originatorId: data.userId 
            });
        } catch (error) {
            this.logger.warn({ message: 'Sync operational request failed runtime execution check', roomId: data.roomId, requestingId: data.userId, action: data.action, error: (error as Error).message });
            socket.emit('room:error', { message: (error as Error).message });
        }
    }

    @SubscribeMessage('room:telemetry:ping')
    handleNetworkTelemetry(
        @ConnectedSocket() socket: Socket,
        @MessageBody() data: { roomId: string; userId: string; clientTimestamp: number }
    ) {
        const actor = this.runningActors.get(data.roomId);
        if (actor) {
            const computedRoundTripLatency = Date.now() - data.clientTimestamp;
            actor.updateTelemetry({ userId: data.userId, score: computedRoundTripLatency });
            
            this.logger.debug?.({ message: 'Network latency telemetry parsed', roomId: data.roomId, userId: data.userId, computedRoundTripLatency });
            socket.emit('room:telemetry:pong', { currentLatency: computedRoundTripLatency });
        }
    }
}