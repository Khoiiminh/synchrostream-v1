import { Injectable } from "@nestjs/common";
import { PostgresProvider } from "@/shared/infrastructure/database/postgres.provider.js";
import type { SqlExecutor } from "@/shared/infrastructure/database/sql-executor.js";
import type { Tx } from "../../application/ports/transaction.js";
import type {
    ActiveMembershipRow,
    CountRow,
    CreatedRoomRow,
    CurrentRoomRow,
    IdRow,
    InactiveRoomRow,
    LockedRoomRow,
    MemberUserRow,
    MembershipRoomRow,
    OwnedRoomRow,
    ParticipantRow,
    RoomDetails,
    RoomProjectionRow,
    RoomStatusRow,
    StateVersionRow,
    UserSessionRow,
} from "../../watch-party.types.js";
import type {
    NewRoom,
    WatchPartyStore,
} from "../../application/ports/watch-party-store.port.js";
import {
    ActiveMembershipConflict,
    RoomCodeConflict,
} from "../../application/ports/store-errors.js";

/** pg error code for unique_violation. */
const UNIQUE_VIOLATION = "23505";

/**
 * Re-raises a unique violation on one of the watch-party partial indexes as
 * the store conflict the use cases understand; anything else unchanged.
 */
function translateUniqueViolation(error: unknown): never {
    const pgError = error as { code?: string; constraint?: string } | null;
    if (pgError?.code === UNIQUE_VIOLATION) {
        if (pgError.constraint === "idx_active_room_code") {
            throw new RoomCodeConflict({ cause: error });
        }
        if (pgError.constraint === "idx_one_active_room_per_user") {
            throw new ActiveMembershipConflict({ cause: error });
        }
    }
    throw error;
}

/**
 * All SQL for watch rooms and their memberships: the Postgres adapter of the
 * WatchPartyStore port.
 *
 * Methods that may run inside a caller's transaction take `db` first. Passing
 * `undefined` runs the statement on the pool.
 */
@Injectable()
export class WatchPartyRepository implements WatchPartyStore {
    constructor(private readonly pg: PostgresProvider) {}

    withTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
        return this.pg.withTransaction(work);
    }

    /** The one place a port Tx becomes a pg executor; undefined means the pool. */
    private executor(tx: Tx | undefined): SqlExecutor {
        return (tx as SqlExecutor | undefined) ?? this.pg;
    }

    /** Serializes room creation for one owner across backend instances (transaction-scoped). */
    async acquireOwnerRoomCreationLock(
        tx: Tx | undefined,
        ownerId: string,
    ): Promise<void> {
        const db = this.executor(tx);
        await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
            `watch-room-owner:${ownerId}`,
        ]);
    }

    /** A PROVISIONING/ACTIVE room owned by the user, if any. */
    async findOwnedLiveRoom(
        tx: Tx | undefined,
        ownerId: string,
    ): Promise<OwnedRoomRow | undefined> {
        const db = this.executor(tx);
        const existingRoom = await db.query<OwnedRoomRow>(
            `
                    SELECT id, room_code
                    FROM public.rooms
                    WHERE owner_id = $1 AND lifecycle_status IN ('PROVISIONING', 'ACTIVE')
                    LIMIT 1`,
            [ownerId],
        );
        return existingRoom.rows[0];
    }

    /** Clears the user's active memberships whose room has fully terminated. */
    async deactivateMembershipsInTerminatedRooms(
        tx: Tx | undefined,
        userId: string,
    ): Promise<void> {
        const db = this.executor(tx);
        await db.query(
            `
                    UPDATE public.room_participants AS rp
                    SET is_active = false,
                        left_at = COALESCE(rp.left_at, NOW())
                    FROM public.rooms AS r
                    WHERE rp.room_id = r.id
                        AND rp.user_id = $1
                        AND rp.is_active = true
                        AND r.lifecycle_status = 'TERMINATED'`,
            [userId],
        );
    }

    async insertProvisioningRoom(
        tx: Tx | undefined,
        room: NewRoom,
    ): Promise<CreatedRoomRow> {
        const db = this.executor(tx);
        const insertRoomQuery = `
                    INSERT INTO public.rooms (
                        room_code,
                        "password",
                        owner_id,
                        movie_id,
                        max_participants,
                        is_active,
                        lifecycle_status,
                        state_version
                    )
                    VALUES ($1, $2, $3, $4, $5, false, 'PROVISIONING', 1)
                    RETURNING
                        id, room_code, owner_id, movie_id, max_participants, state_version`;

        const result = await db
            .query<CreatedRoomRow>(insertRoomQuery, [
                room.roomCode,
                room.passwordHash,
                room.ownerId,
                room.movieId,
                room.maxParticipants,
            ])
            .catch(translateUniqueViolation);
        return result.rows[0];
    }

    async insertOwnerParticipant(
        tx: Tx | undefined,
        roomId: string,
        ownerId: string,
    ): Promise<void> {
        const db = this.executor(tx);
        const createOwnerParticipantQuery = `
                    INSERT INTO public.room_participants (
                        room_id,
                        user_id, 
                        has_control_privilege
                    )
                    VALUES ($1, $2, true)`;

        await db
            .query(createOwnerParticipantQuery, [roomId, ownerId])
            .catch(translateUniqueViolation);
    }

    /** Locks (`FOR UPDATE`) the PROVISIONING/ACTIVE room with this normalized code. */
    async lockLiveRoomByCode(
        tx: Tx | undefined,
        cleanCode: string,
    ): Promise<LockedRoomRow | undefined> {
        const db = this.executor(tx);
        const roomResult = await db.query<LockedRoomRow>(
            `
                        SELECT
                            id,
                            room_code,
                            "password",
                            owner_id,
                            movie_id,
                            max_participants,
                            lifecycle_status,
                            state_version
                        FROM public.rooms
                        WHERE UPPER(TRIM(room_code)) = $1
                        AND lifecycle_status IN ('PROVISIONING', 'ACTIVE')
                        FOR UPDATE
                        `,
            [cleanCode],
        );
        return roomResult.rows[0];
    }

    async findActiveParticipant(
        tx: Tx | undefined,
        roomId: string,
        userId: string,
    ): Promise<ParticipantRow | undefined> {
        const db = this.executor(tx);
        const existingParticipantResult = await db.query<ParticipantRow>(
            `
                        SELECT
                            id,
                            room_id,
                            user_id,
                            has_control_privilege
                        FROM public.room_participants
                        WHERE room_id = $1
                        AND user_id = $2
                        AND is_active = true
                        LIMIT 1
                        `,
            [roomId, userId],
        );
        return existingParticipantResult.rows[0];
    }

    async countActiveParticipants(
        tx: Tx | undefined,
        roomId: string,
    ): Promise<number> {
        const db = this.executor(tx);
        const countResult = await db.query<CountRow>(
            `
                        SELECT COUNT(*)::int AS count
                        FROM public.room_participants
                        WHERE room_id = $1
                        AND is_active = true
                        `,
            [roomId],
        );
        return countResult.rows[0].count;
    }

    async insertParticipant(
        tx: Tx | undefined,
        roomId: string,
        userId: string,
    ): Promise<ParticipantRow> {
        const db = this.executor(tx);
        const participantResult = await db.query<ParticipantRow>(
            `
                            INSERT INTO public.room_participants (
                                room_id,
                                user_id
                            )
                            VALUES ($1, $2)
                            RETURNING
                                id,
                                room_id,
                                user_id,
                                has_control_privilege
                            `,
            [roomId, userId],
        ).catch(translateUniqueViolation);
        return participantResult.rows[0];
    }

    /** Bumps `state_version` of an ACTIVE room and returns the new version. */
    async incrementActiveRoomStateVersion(
        tx: Tx | undefined,
        roomId: string,
    ): Promise<string> {
        const db = this.executor(tx);
        const versionResult = await db.query<StateVersionRow>(
            `UPDATE public.rooms
                             SET state_version = state_version + 1
                             WHERE id = $1 AND lifecycle_status = 'ACTIVE'
                             RETURNING state_version`,
            [roomId],
        );
        return versionResult.rows[0].state_version;
    }

    async findParticipantRoomId(
        tx: Tx | undefined,
        participantId: string,
    ): Promise<string | undefined> {
        const db = this.executor(tx);
        const membershipLookup = await db.query<MembershipRoomRow>(
            `SELECT room_id FROM public.room_participants WHERE id = $1 LIMIT 1`,
            [participantId],
        );
        return membershipLookup.rows[0]?.room_id;
    }

    /** Locks (`FOR UPDATE`) a room row by id and returns its lifecycle status. */
    async lockRoomStatus(
        tx: Tx | undefined,
        roomId: string,
    ): Promise<RoomStatusRow | undefined> {
        const db = this.executor(tx);
        const roomResult = await db.query<RoomStatusRow>(
            `SELECT id, room_code, lifecycle_status
                         FROM public.rooms WHERE id = $1 FOR UPDATE`,
            [roomId],
        );
        return roomResult.rows[0];
    }

    /** Deactivates one active membership; returns the affected row count. */
    async deactivateParticipant(
        tx: Tx | undefined,
        participantId: string,
        roomId: string,
    ): Promise<number | null> {
        const db = this.executor(tx);
        const deactivated = await db.query<IdRow>(
            `
                        UPDATE public.room_participants
                        SET is_active = false,
                            left_at = NOW()
                        WHERE id = $1 AND room_id = $2
                        AND is_active = true
                        RETURNING id
                        `,
            [participantId, roomId],
        );
        return deactivated.rowCount;
    }

    /** Unconditional `state_version` bump. */
    async incrementRoomStateVersion(
        tx: Tx | undefined,
        roomId: string,
    ): Promise<void> {
        const db = this.executor(tx);
        await db.query(
            `UPDATE public.rooms SET state_version = state_version + 1 WHERE id = $1`,
            [roomId],
        );
    }

    /**
     * Locks (`FOR UPDATE OF r`) the PROVISIONING/ACTIVE room the user owns or
     * actively belongs to, optionally restricted to `roomId`.
     */
    async lockUserLiveSession(
        tx: Tx | undefined,
        userId: string,
        roomId?: string,
    ): Promise<UserSessionRow | undefined> {
        const db = this.executor(tx);
        const userSessionResult = await db.query<UserSessionRow>(
            `
                    SELECT
                        r.id AS room_id,
                        r.room_code,
                        r.owner_id,
                        rp.id AS participant_id
                    FROM public.rooms r
                    LEFT JOIN public.room_participants rp
                        ON r.id = rp.room_id
                        AND rp.user_id = $1
                        AND rp.is_active = true
                    WHERE (
                        r.owner_id = $1
                        OR rp.user_id = $1
                    )
                    AND r.lifecycle_status IN ('PROVISIONING', 'ACTIVE')
                    AND ($2::uuid IS NULL OR r.id = $2::uuid)
                    FOR UPDATE OF r
                    `,
            [userId, roomId ?? null],
        );
        return userSessionResult.rows[0];
    }

    /** A room by id regardless of lifecycle state. */
    async findRoomLifecycle(
        tx: Tx | undefined,
        roomId: string,
    ): Promise<InactiveRoomRow | undefined> {
        const db = this.executor(tx);
        const inactiveRoomResult = await db.query<InactiveRoomRow>(
            `
                            SELECT id AS room_id, room_code, owner_id, lifecycle_status
                            FROM public.rooms
                            WHERE id = $1
                            LIMIT 1`,
            [roomId],
        );
        return inactiveRoomResult.rows[0];
    }

    async listActiveMemberUserIds(
        tx: Tx | undefined,
        roomId: string,
    ): Promise<string[]> {
        const db = this.executor(tx);
        const membersResult = await db.query<MemberUserRow>(
            `
                        SELECT user_id
                        FROM public.room_participants
                        WHERE room_id = $1
                        AND is_active = true
                        `,
            [roomId],
        );
        return membersResult.rows.map((member) => member.user_id);
    }

    /** PROVISIONING/ACTIVE -> TERMINATING. */
    async markRoomTerminating(
        tx: Tx | undefined,
        roomId: string,
    ): Promise<void> {
        const db = this.executor(tx);
        await db.query(
            `
                        UPDATE public.rooms
                        SET is_active = false,
                            lifecycle_status = 'TERMINATING',
                            state_version = state_version + 1
                        WHERE id = $1
                          AND lifecycle_status IN ('PROVISIONING', 'ACTIVE')
                        `,
            [roomId],
        );
    }

    async deactivateAllRoomParticipants(
        tx: Tx | undefined,
        roomId: string,
    ): Promise<void> {
        const db = this.executor(tx);
        await db.query(
            `
                        UPDATE public.room_participants
                        SET is_active = false,
                            left_at = NOW()
                        WHERE room_id = $1
                        AND is_active = true
                        `,
            [roomId],
        );
    }

    async deactivateUserMembership(
        tx: Tx | undefined,
        roomId: string,
        userId: string,
    ): Promise<void> {
        const db = this.executor(tx);
        await db.query(
            `
                    UPDATE public.room_participants
                    SET is_active = false,
                        left_at = NOW()
                    WHERE room_id = $1
                    AND user_id = $2
                    AND is_active = true
                    `,
            [roomId, userId],
        );
    }

    /**
     * The room a user currently occupies, if any: an active membership in a
     * PROVISIONING/ACTIVE room, or a PROVISIONING/ACTIVE room they own.
     * `excludeRoomId` skips the room being joined.
     */
    async findCurrentRoom(
        tx: Tx | undefined,
        userId: string,
        excludeRoomId?: string,
    ): Promise<CurrentRoomRow | undefined> {
        const db = this.executor(tx);
        const result = await db.query<CurrentRoomRow>(
            `SELECT r.id, r.room_code, (r.owner_id = $1) AS is_owner
             FROM public.rooms r
             WHERE r.lifecycle_status IN ('PROVISIONING', 'ACTIVE')
               AND ($2::uuid IS NULL OR r.id <> $2::uuid)
               AND (
                   r.owner_id = $1
                   OR EXISTS (
                       SELECT 1 FROM public.room_participants rp
                       WHERE rp.room_id = r.id AND rp.user_id = $1 AND rp.is_active = true
                   )
               )
             ORDER BY (r.owner_id = $1) DESC
             LIMIT 1`,
            [userId, excludeRoomId ?? null],
        );
        return result.rows[0];
    }

    /** ACTIVE room by normalized code, columns aliased to camelCase. */
    async findActiveRoomDetailsByCode(
        cleanCode: string,
    ): Promise<RoomDetails | undefined> {
        const query = `
            SELECT 
                id AS "roomId",
                room_code AS "roomCode",
                owner_id AS "ownerId",
                movie_id AS "movieId",
                max_participants AS "maxParticipants",
                (lifecycle_status = 'ACTIVE') AS "isActive",
                lifecycle_status AS "lifecycleStatus"
            FROM public.rooms
            WHERE UPPER(TRIM(room_code)) = $1
            AND lifecycle_status = 'ACTIVE'
        `;

        const result = await this.pg.query<RoomDetails>(query, [cleanCode]);
        return result.rows[0];
    }

    async isRoomActive(roomId: string): Promise<boolean> {
        const result = await this.pg.query(
            `SELECT id FROM public.rooms WHERE id = $1 AND lifecycle_status = 'ACTIVE' LIMIT 1`,
            [roomId],
        );
        return Boolean(result.rows[0]);
    }

    /** Active memberships of ACTIVE rooms. */
    async listActiveMemberships(): Promise<ActiveMembershipRow[]> {
        const result = await this.pg.query<ActiveMembershipRow>(
            `SELECT rp.id AS participant_id, rp.room_id, rp.user_id,
                    r.room_code, r.owner_id
             FROM public.room_participants rp
             INNER JOIN public.rooms r ON r.id = rp.room_id
             WHERE rp.is_active = true
               AND r.lifecycle_status = 'ACTIVE'`,
        );
        return result.rows;
    }

    /** Authoritative inputs for rebuilding a room's Redis projection. */
    async findRoomProjection(
        roomId: string,
    ): Promise<RoomProjectionRow | undefined> {
        const result = await this.pg.query<RoomProjectionRow>(
            `SELECT r.id, r.room_code, r.owner_id, r.movie_id, r.max_participants,
                    r.lifecycle_status, r.state_version,
                    (SELECT COUNT(*)::int FROM public.room_participants rp
                     WHERE rp.room_id = r.id AND rp.is_active = true) AS participant_count
             FROM public.rooms r WHERE r.id = $1`,
            [roomId],
        );
        return result.rows[0];
    }
}
