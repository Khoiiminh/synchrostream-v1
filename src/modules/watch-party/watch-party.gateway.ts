import {
    BadRequestException,
    Inject,
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
import { JoinRoomDto, WatchPartyService } from "./watch-party.service.js";
import { WsJwtGuard } from "../auth/guards/ws-jwt.guard.js";
import type { AuthenticatedSocket } from "@/shared/auth/auth-context.types.js";
import { RoomChatRelay } from "./room-chat.relay.js";
import type { ChatSendAck } from "./watch-party.types.js";
import type {
    MediaSessionPort,
    RealtimeStatePort,
} from "./application/ports/collaborators.port.js";
import { MEDIA_SESSION, REALTIME_STATE } from "./application/ports/tokens.js";
import {
    RoomRuntimeRegistry,
    type RealtimeContext,
} from "./presentation/realtime/realtime-context.js";
import { MembershipLifecycle } from "./presentation/realtime/membership-lifecycle.js";
import { MediaStartup } from "./presentation/realtime/media-startup.js";
import { ChatChannel } from "./presentation/realtime/chat-channel.js";
import { PlaybackSync } from "./presentation/realtime/playback-sync.js";
import { RoomHandshake } from "./presentation/realtime/room-handshake.js";

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

    /*
     * Phase 4: the room runtime lives in presentation/realtime. This class
     * keeps the Socket.IO surface (decorators, guards, payload shapes) and
     * delegates each event to one collaborator.
     */
    private readonly registry: RoomRuntimeRegistry;
    private readonly lifecycle: MembershipLifecycle;
    private readonly handshake: RoomHandshake;
    private readonly playback: PlaybackSync;
    private readonly chat: ChatChannel;

    constructor(
        watchPartyService: WatchPartyService,
        @Inject(REALTIME_STATE) redis: RealtimeStatePort,
        @Inject(MEDIA_SESSION) liveKitService: MediaSessionPort,
        chatRelay: RoomChatRelay,
    ) {
        // Read lazily: @WebSocketServer() assigns `server` after construction.
        const currentServer = () => this.server;
        this.registry = new RoomRuntimeRegistry(
            (socketId) =>
                currentServer()?.sockets.get(socketId)?.connected === true,
        );
        const ctx = {
            get server() {
                return currentServer();
            },
            logger: this.logger,
            registry: this.registry,
            watchPartyService,
            redis,
            liveKitService,
            chatRelay,
        } as RealtimeContext & Record<string, unknown>;
        this.lifecycle = new MembershipLifecycle(ctx);
        this.playback = new PlaybackSync(ctx);
        this.chat = new ChatChannel(ctx);
        this.handshake = new RoomHandshake(ctx);
        Object.assign(ctx, {
            lifecycle: this.lifecycle,
            media: new MediaStartup(ctx),
            chat: this.chat,
            playback: this.playback,
        });
    }

    onModuleInit(): void {
        this.lifecycle.start();
    }

    onModuleDestroy(): void {
        this.lifecycle.stop();
    }

    handleDisconnect(socket: AuthenticatedSocket): Promise<void> {
        return this.lifecycle.handleDisconnect(socket);
    }

    /** Voluntary leave without grace; also used by the REST leave and room switch. */
    leaveRoomVoluntarily(
        userId: string,
        roomId: string,
        requestingSocketId?: string,
    ): Promise<string> {
        return this.lifecycle.leaveRoomVoluntarily(
            userId,
            roomId,
            requestingSocketId,
        );
    }

    @SubscribeMessage("room:leave")
    @UseGuards(WsJwtGuard)
    handleLeaveRoom(
        @ConnectedSocket() socket: AuthenticatedSocket,
    ): Promise<{ ok: boolean; status?: string; message?: string }> {
        return this.lifecycle.leaveRoom(socket);
    }

    @SubscribeMessage("room:connect")
    @UseGuards(WsJwtGuard)
    handleConnectionHandshake(
        @ConnectedSocket() socket: AuthenticatedSocket,
        @MessageBody() payload: { dto: JoinRoomDto; leaveCurrent?: boolean },
    ): Promise<void> {
        return this.handshake.handleConnectionHandshake(socket, payload);
    }

    @SubscribeMessage("room:sync:pulse")
    @UseGuards(WsJwtGuard)
    handlePlaybackPulse(
        @ConnectedSocket() socket: AuthenticatedSocket,
        @MessageBody()
        data: {
            roomId: string;
            roomCode: string;
            action: "PLAY" | "PAUSE" | "SEEK";
            playhead: number;
        },
    ): Promise<void> {
        return this.playback.handlePlaybackPulse(socket, data);
    }

    /**
     * Chat send. The socket's room binding is authoritative: `roomCode` in the
     * body is ignored, so a member can only post to the room it is bound to.
     */
    @SubscribeMessage("room:chat:message")
    @UseGuards(WsJwtGuard)
    handleChatMessage(
        @ConnectedSocket() socket: AuthenticatedSocket,
        @MessageBody()
        data:
            | {
                  roomCode?: string;
                  message?: unknown;
                  clientMessageId?: unknown;
              }
            | undefined,
    ): Promise<ChatSendAck> {
        return this.chat.handleChatMessage(socket, data);
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

        const metadata = this.registry.socketToParticipantMap.get(socket.id);

        if (!metadata) {
            throw new BadRequestException(
                "Telemetry transmission rejected: socket is not bound to a room.",
            );
        }

        /*
         * Do not trust data.roomId or data.userId from the client.
         */
        const actor = this.registry.runningActors.get(metadata.roomId);

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
