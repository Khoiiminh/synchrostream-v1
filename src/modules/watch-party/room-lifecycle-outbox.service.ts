import { RedisProvider } from "@/shared/infrastructure/cache/redis.provider.js";
import {
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
} from "@nestjs/common";
import { LiveKitService } from "../livekit/livekit.service.js";
import type { TransactionClient } from "@/shared/infrastructure/database/sql-executor.js";
import { RoomLifecycleOutboxRepository } from "./room-lifecycle-outbox.repository.js";
import type {
    OutboxEvent,
    RoomProjectionRow as RoomProjection,
} from "./watch-party.types.js";

/** Lease duration written on claim. Event work is bounded below this. */
const LEASE_SECONDS = 30;
/** Hard bound for one event's side effects so a hung call cannot outlive its lease. */
const EVENT_TIMEOUT_MS = 25_000;
/** Attempts before an event is parked as DEAD (the sweeper re-enqueues the aggregate). */
const DEAD_LETTER_ATTEMPTS = 20;
/** A room that cannot be provisioned within this window is terminated. */
const PROVISIONING_TIMEOUT_MINUTES = 10;
/** Only media sessions stuck at least this long are re-enqueued by the sweeper. */
const STUCK_MEDIA_SESSION_MINUTES = 2;
/** COMPLETED events are kept this long for diagnostics, then pruned. */
const COMPLETED_RETENTION_DAYS = 7;
const SWEEP_INTERVAL_MS = 60_000;

@Injectable()
export class RoomLifecycleOutboxService
    implements OnModuleInit, OnModuleDestroy
{
    private readonly logger = new Logger(RoomLifecycleOutboxService.name);
    private timer?: NodeJS.Timeout;
    private sweepTimer?: NodeJS.Timeout;
    private processing = false;
    private sweeping = false;
    private readonly workerId = `room-lifecycle-${process.pid}-${Math.random().toString(36).slice(2)}`;

    constructor(
        private readonly repo: RoomLifecycleOutboxRepository,
        private readonly redis: RedisProvider,
        private readonly liveKit: LiveKitService,
    ) {}

    onModuleInit(): void {
        // Recover pending and expired-lease work after startup, then keep draining.
        this.timer = setInterval(() => void this.processBatch(), 500);
        this.timer.unref?.();
        void this.processBatch();

        // The sweeper guarantees convergence: no room or LiveKit session may stay
        // in a transitional state just because its event reached DEAD or was lost.
        this.sweepTimer = setInterval(
            () => void this.sweep(),
            SWEEP_INTERVAL_MS,
        );
        this.sweepTimer.unref?.();
        void this.sweep();
    }

    onModuleDestroy(): void {
        if (this.timer) clearInterval(this.timer);
        if (this.sweepTimer) clearInterval(this.sweepTimer);
    }

    /** Inside the caller's transaction: enqueue a reconciliation of one room. */
    async enqueueRoomReconciliation(
        client: TransactionClient,
        roomId: string,
    ): Promise<void> {
        await this.repo.enqueueRoomReconciliation(client, roomId);
    }

    /** Outside a transaction: request a durable reconciliation of one room. */
    async requestRoomReconciliation(roomId: string): Promise<void> {
        await this.repo.enqueueRoomReconciliation(undefined, roomId);
    }

    async provisionRoomNow(roomId: string): Promise<void> {
        // Keep room creation responsive when dependencies are healthy; the durable
        // outbox event remains the recovery path if this attempt is interrupted.
        await this.withTimeout(
            this.reconcileRoom(roomId),
            EVENT_TIMEOUT_MS,
            "Inline room provisioning",
        );
    }

    private async processBatch(): Promise<void> {
        if (this.processing) return;
        this.processing = true;
        try {
            // A small batch bounds lock duration and lets multiple instances share work.
            for (let index = 0; index < 10; index += 1) {
                const event = await this.claimEvent();
                if (!event) break;
                await this.processEvent(event);
            }
        } catch (error) {
            this.logger.error({
                message: "Room lifecycle outbox polling failed",
                err: error,
            });
        } finally {
            this.processing = false;
        }
    }

    private async claimEvent(): Promise<OutboxEvent | null> {
        return this.repo.withTransaction(async (client) =>
            this.repo.claimNextEvent(client, this.workerId, LEASE_SECONDS),
        );
    }

    private async processEvent(event: OutboxEvent): Promise<void> {
        try {
            const work =
                event.event_type === "ROOM_RECONCILE"
                    ? this.reconcileRoom(event.aggregate_id)
                    : this.liveKit.reconcileMediaSession(
                          event.aggregate_id,
                          event.created_at,
                      );
            await this.withTimeout(
                work,
                EVENT_TIMEOUT_MS,
                `${event.event_type} ${event.event_id}`,
            );

            await this.repo.markEventCompleted(event.event_id, this.workerId);
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            const delaySeconds = Math.min(
                300,
                2 ** Math.min(event.attempts, 8),
            );
            const deadLetter = event.attempts >= DEAD_LETTER_ATTEMPTS;
            await this.repo.markEventFailed(
                event.event_id,
                this.workerId,
                delaySeconds,
                message.slice(0, 4000),
                deadLetter,
            );
            this.logger[deadLetter ? "error" : "warn"]({
                message: deadLetter
                    ? "Room lifecycle event reached the dead-letter threshold; the sweeper will re-enqueue the aggregate while it remains unconverged"
                    : "Room lifecycle reconciliation will be retried",
                eventId: event.event_id,
                eventType: event.event_type,
                aggregateId: event.aggregate_id,
                attempts: event.attempts,
                error: message,
            });
        }
    }

    /**
     * Periodic convergence pass. One instance runs it per tick (advisory lock).
     * - PROVISIONING rooms past the timeout are moved to TERMINATING.
     * - PROVISIONING/TERMINATING rooms with no live event get a new one, so a
     *   DEAD event never leaves a room stuck (the DEAD row stays for diagnostics).
     * - Stuck LiveKit sessions (STARTING/ENDING, or CREATED on a room that is
     *   no longer ACTIVE) with no live event get a new one.
     * - Old COMPLETED events are pruned.
     */
    private async sweep(): Promise<void> {
        if (this.sweeping) return;
        this.sweeping = true;
        try {
            await this.repo.withTransaction(async (client) => {
                if (!(await this.repo.tryAcquireSweeperLock(client))) return;

                const timedOut =
                    await this.repo.terminateTimedOutProvisioningRooms(
                        client,
                        PROVISIONING_TIMEOUT_MINUTES,
                    );
                for (const room of timedOut) {
                    await this.repo.deactivateActiveParticipants(
                        client,
                        room.id,
                    );
                    await this.enqueueRoomReconciliation(client, room.id);
                    this.logger.warn({
                        message:
                            "Room could not be provisioned in time and is being terminated",
                        roomId: room.id,
                        timeoutMinutes: PROVISIONING_TIMEOUT_MINUTES,
                    });
                }

                const requeuedRooms =
                    await this.repo.requeueUnconvergedRooms(client);

                // Rooms without lifecycle states before v7 cannot be told apart by
                // provider; only transitional or orphaned sessions are touched, and
                // ending one deletes a LiveKit room by its id (404 = success).
                const requeuedSessions =
                    await this.repo.requeueStuckMediaSessions(
                        client,
                        STUCK_MEDIA_SESSION_MINUTES,
                    );

                const pruned = await this.repo.pruneCompletedEvents(
                    client,
                    COMPLETED_RETENTION_DAYS,
                );

                if (requeuedRooms || requeuedSessions) {
                    this.logger.warn({
                        message:
                            "Lifecycle sweeper re-enqueued unconverged aggregates",
                        rooms: requeuedRooms,
                        mediaSessions: requeuedSessions,
                    });
                }
                if (pruned) {
                    this.logger.debug({
                        message: "Pruned completed lifecycle events",
                        count: pruned,
                    });
                }
            });
        } catch (error) {
            this.logger.error({
                message: "Room lifecycle sweeper failed",
                err: error,
            });
        } finally {
            this.sweeping = false;
        }
    }

    private async reconcileRoom(roomId: string): Promise<void> {
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
                    await this.enqueueRoomReconciliation(client, room.id);
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
                    await this.enqueueRoomReconciliation(client, room.id);
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

    private async withTimeout<T>(
        work: Promise<T>,
        timeoutMs: number,
        label: string,
    ): Promise<T> {
        let timeoutId: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(
                () =>
                    reject(
                        new Error(`${label} timed out after ${timeoutMs} ms`),
                    ),
                timeoutMs,
            );
        });
        try {
            return await Promise.race([work, timeout]);
        } finally {
            if (timeoutId) clearTimeout(timeoutId);
        }
    }
}
