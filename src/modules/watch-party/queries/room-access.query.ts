import { Injectable } from "@nestjs/common";
import { PostgresProvider } from "@/shared/infrastructure/database/postgres.provider.js";
import type { SqlExecutor } from "@/shared/infrastructure/database/sql-executor.js";

/*
 * Watch-party's published read contract (refactor plan §6). `rooms` and
 * `room_participants` belong to watch-party; other modules (LiveKit, media
 * sessions) ask through this class instead of querying the tables.
 *
 * The SQL was moved byte-for-byte from livekit.repository.ts and
 * media-session.repository.ts, so behaviour is unchanged.
 */

/** An active member of an ACTIVE room. */
export interface ActiveRoomMember {
    participant_id: string;
    user_id: string;
    room_id: string;
}

/** An ACTIVE room and its capacity. */
export interface ActiveRoomCapacity {
    id: string;
    max_participants: number;
}

/** A room's `is_active` flag (true exactly when ACTIVE). */
export interface RoomActivity {
    id: string;
    is_active: boolean;
}

/** A membership row of any state. */
export interface RoomMembership {
    participant_id: string;
    user_id: string;
    room_id: string;
}

@Injectable()
export class RoomAccessQuery {
    constructor(private readonly pg: PostgresProvider) {}

    /** Membership id of an active member of an ACTIVE room, if any. */
    async findActiveMembershipId(
        roomId: string,
        userId: string,
    ): Promise<string | undefined> {
        const result = await this.pg.query<{ id: string }>(
            `SELECT rp.id
             FROM public.room_participants rp
             INNER JOIN public.rooms r ON r.id = rp.room_id
             WHERE rp.room_id = $1 AND rp.user_id = $2
               AND rp.is_active = true AND r.lifecycle_status = 'ACTIVE'
             LIMIT 1`,
            [roomId, userId],
        );
        return result.rows[0]?.id;
    }

    /** Whether the room exists and is ACTIVE (`SELECT 1` probe). */
    async isRoomActive(roomId: string): Promise<boolean> {
        const result = await this.pg.query(
            `SELECT 1 FROM public.rooms WHERE id = $1 AND lifecycle_status = 'ACTIVE'`,
            [roomId],
        );
        return Boolean(result.rows[0]);
    }

    /** Id of the room if it exists and is ACTIVE. */
    async findActiveRoomId(roomId: string): Promise<string | undefined> {
        const result = await this.pg.query<{ id: string }>(
            `SELECT id FROM public.rooms WHERE id = $1 AND lifecycle_status = 'ACTIVE' LIMIT 1`,
            [roomId],
        );
        return result.rows[0]?.id;
    }

    /** The active participant row for a user in an ACTIVE room, if any. */
    async findActiveParticipant(
        roomId: string,
        userId: string,
    ): Promise<ActiveRoomMember | undefined> {
        const participantQuery = `
            SELECT
                rp.id AS participant_id,
                rp.user_id,
                rp.room_id
            FROM public.room_participants rp
            INNER JOIN public.rooms r ON r.id = rp.room_id
            WHERE rp.room_id = $1
            AND rp.user_id = $2
            AND rp.is_active = true
            AND r.lifecycle_status = 'ACTIVE'
            LIMIT 1
        `;

        const result = await this.pg.query<ActiveRoomMember>(participantQuery, [
            roomId,
            userId,
        ]);
        return result.rows[0];
    }

    /** The ACTIVE room with its capacity, if it exists. */
    async findActiveRoom(
        roomId: string,
    ): Promise<ActiveRoomCapacity | undefined> {
        const roomQuery = `
            SELECT
                id,
                max_participants
            FROM public.rooms
            WHERE id = $1
            AND lifecycle_status = 'ACTIVE'
            LIMIT 1
        `;

        const result = await this.pg.query<ActiveRoomCapacity>(roomQuery, [
            roomId,
        ]);
        return result.rows[0];
    }

    /**
     * Inside the caller's transaction: locks the room row `FOR UPDATE` if it
     * is ACTIVE, so a media-session transition cannot race room termination.
     * Returns whether the room was found ACTIVE.
     */
    async lockActiveRoom(db: SqlExecutor, roomId: string): Promise<boolean> {
        const result = await db.query(
            `SELECT id FROM public.rooms
                 WHERE id = $1 AND lifecycle_status = 'ACTIVE'
                 FOR UPDATE`,
            [roomId],
        );
        return Boolean(result.rows[0]);
    }

    /** The room's `is_active` flag, for any lifecycle state. */
    async findRoomActivity(roomId: string): Promise<RoomActivity | undefined> {
        const query = `SELECT
             id, is_active
            FROM public.rooms
            WHERE id = $1`;

        const result = await this.pg.query<RoomActivity>(query, [roomId]);
        return result.rows[0];
    }

    /** The user's membership row in the room, active or not. */
    async findRoomParticipant(
        roomId: string,
        userId: string,
    ): Promise<RoomMembership | undefined> {
        const participantQuery = `
            SELECT
                rp.id AS participant_id,
                rp.user_id,
                rp.room_id
            FROM public.room_participants rp
            WHERE rp.room_id = $1
            AND rp.user_id = $2
            LIMIT 1
        `;

        const result = await this.pg.query<RoomMembership>(participantQuery, [
            roomId,
            userId,
        ]);
        return result.rows[0];
    }
}
