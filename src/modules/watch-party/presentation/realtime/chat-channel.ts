import type { AuthenticatedSocket } from "@/shared/auth/auth-context.types.js";
import type { ChatSendAck } from "../../watch-party.types.js";
import type { RealtimeContext } from "./realtime-context.js";

/** room:chat:message and the history sent to a freshly bound socket. */
export class ChatChannel {
    constructor(private readonly ctx: RealtimeContext) {}

    /**
     * Chat send. The socket's room binding is authoritative: `roomCode` in the
     * body is ignored, so a member can only post to the room it is bound to.
     * The sender gets an ack; everyone in the room (sender's other sockets
     * included) gets `room:chat:broadcast`.
     */
    async handleChatMessage(
        socket: AuthenticatedSocket,
        data:
            | {
                  roomCode?: string;
                  message?: unknown;
                  clientMessageId?: unknown;
              }
            | undefined,
    ): Promise<ChatSendAck> {
        const user = socket.data.user;
        const binding = this.ctx.registry.socketToParticipantMap.get(socket.id);

        if (!user || !binding || binding.userId !== user.id) {
            return {
                ok: false,
                code: "NOT_IN_ROOM",
                message: "Join the room before sending messages.",
            };
        }

        const result = await this.ctx.chatRelay.submit({
            roomId: binding.roomId,
            userId: user.id,
            username: user.username,
            rawMessage: data?.message,
            rawClientMessageId: data?.clientMessageId,
        });

        if (!result.accepted) {
            this.ctx.logger.debug({
                message: "Chat message rejected",
                roomId: binding.roomId,
                userId: user.id,
                code: result.ack.code,
            });
            return result.ack;
        }

        // The binding may have been dropped (leave, termination) while the
        // insert ran; do not broadcast into a room this socket no longer holds.
        if (
            this.ctx.registry.socketToParticipantMap.get(socket.id)?.roomId !==
            binding.roomId
        ) {
            return {
                ok: false,
                code: "NOT_IN_ROOM",
                message: "You are no longer in this room.",
            };
        }

        this.ctx.server
            .to(binding.roomId)
            .emit("room:chat:broadcast", result.payload);

        return {
            ok: true,
            id: result.payload.id,
            timestamp: result.payload.timestamp,
        };
    }

    /**
     * Sends the room's recent chat to one freshly bound socket. Never fails the
     * handshake: without history the member still gets live messages.
     */
    async sendChatHistory(
        socket: AuthenticatedSocket,
        roomId: string,
    ): Promise<void> {
        try {
            const messages = await this.ctx.chatRelay.getRecentHistory(roomId);
            if (
                this.ctx.registry.socketToParticipantMap.get(socket.id)
                    ?.roomId !== roomId
            )
                return;
            socket.emit("room:chat:history", { roomId, messages });
        } catch (error) {
            this.ctx.logger.warn({
                message: "Failed to load chat history for a bound socket",
                roomId,
                socketId: socket.id,
                err: error,
            });
        }
    }
}
