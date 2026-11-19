import type { WatchPartyLogger } from "../logger.port.js";
import type { OutboxStore } from "../ports/outbox-store.port.js";
import type {
    MediaSessionPort,
    RoomStateProjectionPort,
} from "../ports/collaborators.port.js";
import type { RoomProjectionRow as RoomProjection } from "../../watch-party.types.js";

/**
 * Use case: converge one room's Redis projection, provider state and
 * lifecycle with PostgreSQL, according to its current lifecycle status.
 * Throws when it cannot converge yet, so the outbox event is retried.
 */
export class ReconcileRoom {
    constructor(
        private readonly repo: OutboxStore,
        // Field names kept from the outbox service, so the moved code is unchanged.
        private readonly redis: RoomStateProjectionPort,
        private readonly liveKit: MediaSessionPort,
        private readonly logger: WatchPartyLogger,
    ) {}

    async execute(roomId: string): Promise<void> {
        const room = await this.repo.findRoomProjection(roomId);
        if (!room) return;

        if (room.lifecycle_status === "PROVISIONING") {
            const projected = await this.projectRoom(room, {
                roomId: room.id,
                lifecycleVersion: room.state_version,
                lifecycleStatus: "PROVISIONING",
                roomCode: room.room_code,
                ownerId: room.owner_id,
                movieId: room.movie_id,
                maxParticipants: room.max_participants,
                participantCount: room.participant_count,
                status: "PAUSED",
                playhead: 0,
                lastUpdated: Date.now(),
            });
            if (!projected) {
                throw new Error(
                    "Redis room-code key is owned by a different nonterminated room generation.",
                );
            }

            await this.repo.withTransaction(async (client) => {
                const activated = await this.repo.activateProvisioningRoom(
                    client,
                    room.id,
                    room.state_version,
                );
                if (activated) {
                    await this.repo.enqueueRoomReconciliation(client, room.id);
                }
            });
            return;
        }

        if (room.lifecycle_status === "TERMINATING") {
            // LiveKit names provider rooms with this immutable media-session UUID.
            await this.liveKit.endMediaSessionForRoom(room.id);
            await this.redis.reconcileRoomState(room.room_code, {
                roomId: room.id,
                lifecycleVersion: room.state_version,
                lifecycleStatus: "TERMINATED",
            });

            await this.repo.withTransaction(async (client) => {
                const terminated = await this.repo.markRoomTerminated(
                    client,
                    room.id,
                    room.state_version,
                );
                if (terminated) {
                    await this.repo.enqueueRoomReconciliation(client, room.id);
                }
            });
            return;
        }

        const state = {
            roomId: room.id,
            lifecycleVersion: room.state_version,
            lifecycleStatus: room.lifecycle_status,
            roomCode: room.room_code,
            ownerId: room.owner_id,
            movieId: room.movie_id,
            maxParticipants: room.max_participants,
            participantCount: room.participant_count,
        };

        if (room.lifecycle_status === "TERMINATED") {
            // A tombstone rejected because a newer generation owns the code is fine.
            await this.redis.reconcileRoomState(room.room_code, state);
            return;
        }

        if (!(await this.projectRoom(room, state))) {
            throw new Error(
                "Redis room-code key is owned by a different nonterminated room generation.",
            );
        }

        // Media access follows membership: remove provider participants whose
        // membership is no longer active. Provider participants are listed first
        // and memberships read afterwards, so a member who joined in between is
        // never removed (their token required an already-committed membership).
        await this.liveKit.reconcileRoomParticipants(room.id, async () => {
            const members = await this.repo.listActiveParticipantIds(room.id);
            return new Set(members.map((member) => member.id));
        });
    }

    /**
     * Applies a versioned projection. When the room code's key is held by another
     * room id, takes it over only after PostgreSQL proves that room no longer
     * owns the code (missing, TERMINATED, or a different code). Returns false
     * only when a genuinely live generation holds the key.
     */
    private async projectRoom(
        room: RoomProjection,
        state: Record<string, string | number>,
    ): Promise<boolean> {
        if (await this.redis.reconcileRoomState(room.room_code, state))
            return true;

        const existing = await this.redis.getRoomState(room.room_code);
        // Same generation with a newer version: a later reconciliation already
        // projected fresher state, which is the desired outcome.
        if (!existing.roomId || existing.roomId === room.id) return true;

        const holderRow = await this.repo.findRoomCodeHolder(existing.roomId);
        const holderStillOwnsCode =
            holderRow &&
            holderRow.room_code === room.room_code &&
            holderRow.lifecycle_status !== "TERMINATED";
        if (holderStillOwnsCode) return false;

        const replaced = await this.redis.replaceStaleRoomState(
            room.room_code,
            existing.roomId,
            state,
        );
        if (replaced) {
            this.logger.warn({
                message:
                    "Replaced stale Redis room projection left by a terminated or legacy room",
                roomCode: room.room_code,
                staleRoomId: existing.roomId,
                roomId: room.id,
            });
            return true;
        }
        // The key changed concurrently; let the event retry.
        return false;
    }
}
