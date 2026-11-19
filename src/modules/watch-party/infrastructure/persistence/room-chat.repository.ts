import { Injectable } from "@nestjs/common";
import { PostgresProvider } from "@/shared/infrastructure/database/postgres.provider.js";
import type {
    ChatHistoryRow,
    InsertedChatRow,
} from "../../watch-party.types.js";
import type { ChatStore } from "../../application/ports/collaborators.port.js";

/**
 * All SQL for `chat_history` (the ChatStore adapter). Rows are scoped to one
 * room generation (`room_id`).
 */
@Injectable()
export class RoomChatRepository implements ChatStore {
    constructor(private readonly pg: PostgresProvider) {}

    async insertMessage(params: {
        roomId: string;
        userId: string;
        senderName: string;
        message: string;
    }): Promise<InsertedChatRow> {
        const result = await this.pg.query<InsertedChatRow>(
            `
                    INSERT INTO public.chat_history (room_id, user_id, sender_name_at_time, message)
                    VALUES ($1, $2, $3, $4)
                    RETURNING id::text AS id, sent_at`,
            [params.roomId, params.userId, params.senderName, params.message],
        );
        return result.rows[0];
    }

    /** The room's latest `limit` messages, oldest first. Served by idx_chat_room_time. */
    async findRecentMessages(
        roomId: string,
        limit: number,
    ): Promise<ChatHistoryRow[]> {
        const result = await this.pg.query<ChatHistoryRow>(
            `
                    SELECT id::text AS id, user_id, sender_name_at_time, message, sent_at
                    FROM public.chat_history
                    WHERE room_id = $1
                    ORDER BY sent_at DESC, id DESC
                    LIMIT $2`,
            [roomId, limit],
        );
        return result.rows.reverse();
    }
}
