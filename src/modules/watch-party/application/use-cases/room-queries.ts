import type { WatchPartyLogger } from "../logger.port.js";
import type { WatchPartyStore } from "../ports/watch-party-store.port.js";
import { RoomNotAcceptingParticipants } from "../../domain/errors.js";
import { normalizeRoomCode } from "../../domain/room-code.js";

/** Read-side use cases: room lookup, liveness check, sweeper and projection inputs. */
export class RoomQueries {
    constructor(
        private readonly repo: WatchPartyStore,
        private readonly logger: WatchPartyLogger,
    ) {}

    /**
     * Fetches active room details from PostgreSQL by its room code, with automatic
     * sanitization, normalization, and handling for missing or inactive rooms.
     *
     * ### Workflow & Mechanism
     * 1. **Sanitization & Normalization**: Trims whitespace and converts the input `roomCode`
     *    to uppercase to ensure consistent matching against database records.
     * 2. **Database Lookup**: Queries the `public.rooms` table for an active record (`is_active = true`)
     *    matching the normalized code, mapping columns to camelCase aliases (`roomId`, `roomCode`, etc.).
     * 3. **Result Handling**:
     *    - If no matching active room is found, logs a warning and returns `null`.
     *    - If found, returns the mapped room details object from the first row.
     *
     * ### Usage Example
     * ```ts
     * const room = await this.watchPartyService.getRoomDetailsByCode('ROOM123');
     * if (!room) {
     *     // Handle room not found
     * }
     * ```
     *
     * @param roomCode The unique string code of the watch room to look up.
     * @returns A promise resolving with the room details object, or `null` if the room is not found or inactive.
     * @throws {Error} Throws if the database query execution fails unexpectedly.
     */
    async getRoomDetailsByCode(roomCode: string) {
        try {
            const cleanCode = normalizeRoomCode(roomCode);

            const room = await this.repo.findActiveRoomDetailsByCode(cleanCode);

            if (!room) {
                this.logger.warn({
                    message: "Room lookup failed: Code not found or inactive",
                    roomCode,
                });

                return null;
            }

            return room;
        } catch (error) {
            this.logger.error({
                message: "Failed to execute room database lookup query",
                roomCode,
                err: error,
            });

            throw error;
        }
    }

    /**
     * Active memberships of ACTIVE rooms, used by the gateway presence sweeper to
     * find members that have no live socket (e.g. after a backend restart).
     */
    async listActiveMemberships(): Promise<
        Array<{
            participantId: string;
            roomId: string;
            roomCode: string;
            userId: string;
            isOwner: boolean;
        }>
    > {
        const rows = await this.repo.listActiveMemberships();

        return rows.map((row) => ({
            participantId: row.participant_id,
            roomId: row.room_id,
            roomCode: row.room_code,
            userId: row.user_id,
            isOwner: row.owner_id === row.user_id,
        }));
    }

    /** Authoritative inputs for rebuilding a room's Redis projection. */
    async getRoomProjectionState(roomId: string): Promise<{
        roomId: string;
        roomCode: string;
        ownerId: string;
        movieId: string;
        maxParticipants: number;
        lifecycleStatus: string;
        stateVersion: string;
        participantCount: number;
    } | null> {
        const row = await this.repo.findRoomProjection(roomId);
        if (!row) return null;

        return {
            roomId: row.id,
            roomCode: row.room_code,
            ownerId: row.owner_id,
            movieId: row.movie_id,
            maxParticipants: row.max_participants,
            lifecycleStatus: row.lifecycle_status,
            stateVersion: String(row.state_version),
            participantCount: row.participant_count,
        };
    }

    /** @throws RoomNotAcceptingParticipants unless the room is ACTIVE. */
    async assertRoomActive(roomId: string): Promise<void> {
        if (!(await this.repo.isRoomActive(roomId))) {
            throw new RoomNotAcceptingParticipants();
        }
    }
}
