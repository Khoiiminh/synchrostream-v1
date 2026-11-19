import {
    Inject,
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
} from "@nestjs/common";
import { RoomLifecycleOutboxRepository } from "../persistence/room-lifecycle-outbox.repository.js";
import type { Tx } from "../../application/ports/transaction.js";
import type {
    LifecycleOutboxPort,
    MediaSessionPort,
    RoomStateProjectionPort,
} from "../../application/ports/collaborators.port.js";
import {
    MEDIA_SESSION,
    ROOM_STATE_PROJECTION,
} from "../../application/ports/tokens.js";
import { ReconcileRoom } from "../../application/use-cases/reconcile-room.js";
import { ProcessOutboxEvent } from "../../application/use-cases/process-outbox-event.js";
import { SweepLifecycle } from "../../application/use-cases/sweep-lifecycle.js";
import {
    EVENT_TIMEOUT_MS,
    withTimeout,
} from "../../application/use-cases/outbox-policy.js";
import type { OutboxEvent } from "../../watch-party.types.js";

/** Lease duration written on claim. Event work is bounded below this. */
const LEASE_SECONDS = 30;
/** How often the worker polls for due events. */
const POLL_INTERVAL_MS = 500;
/** Events per poll: a small batch bounds lock duration and lets instances share work. */
const BATCH_SIZE = 10;
const SWEEP_INTERVAL_MS = 60_000;

/**
 * The room lifecycle outbox worker (phase 3): Nest lifecycle, timers, the
 * claim loop and re-entrancy guards. The work itself is in the use cases
 * ReconcileRoom, ProcessOutboxEvent and SweepLifecycle.
 *
 * Also the LifecycleOutboxPort adapter: other use cases enqueue through it
 * and call `provisionRoomNow` for the fast path after a commit.
 */
@Injectable()
export class RoomLifecycleOutboxService
    implements OnModuleInit, OnModuleDestroy, LifecycleOutboxPort
{
    private readonly logger = new Logger(RoomLifecycleOutboxService.name);
    private timer?: NodeJS.Timeout;
    private sweepTimer?: NodeJS.Timeout;
    private processing = false;
    private sweeping = false;
    private readonly workerId = `room-lifecycle-${process.pid}-${Math.random().toString(36).slice(2)}`;

    private readonly reconcileRoom: ReconcileRoom;
    private readonly processEvent: ProcessOutboxEvent;
    private readonly sweepLifecycle: SweepLifecycle;

    constructor(
        private readonly repo: RoomLifecycleOutboxRepository,
        @Inject(ROOM_STATE_PROJECTION) projection: RoomStateProjectionPort,
        @Inject(MEDIA_SESSION) media: MediaSessionPort,
    ) {
        this.reconcileRoom = new ReconcileRoom(repo, projection, media, this.logger);
        this.processEvent = new ProcessOutboxEvent(
            repo,
            this.reconcileRoom,
            media,
            this.logger,
        );
        this.sweepLifecycle = new SweepLifecycle(repo, this.logger);
    }

    onModuleInit(): void {
        // Recover pending and expired-lease work after startup, then keep draining.
        this.timer = setInterval(() => void this.processBatch(), POLL_INTERVAL_MS);
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
    async enqueueRoomReconciliation(tx: Tx, roomId: string): Promise<void> {
        await this.repo.enqueueRoomReconciliation(tx, roomId);
    }

    /** Outside a transaction: request a durable reconciliation of one room. */
    async requestRoomReconciliation(roomId: string): Promise<void> {
        await this.repo.enqueueRoomReconciliation(undefined, roomId);
    }

    async provisionRoomNow(roomId: string): Promise<void> {
        // Keep room creation responsive when dependencies are healthy; the durable
        // outbox event remains the recovery path if this attempt is interrupted.
        await withTimeout(
            this.reconcileRoom.execute(roomId),
            EVENT_TIMEOUT_MS,
            "Inline room provisioning",
        );
    }

    private async processBatch(): Promise<void> {
        if (this.processing) return;
        this.processing = true;
        try {
            for (let index = 0; index < BATCH_SIZE; index += 1) {
                const event = await this.claimEvent();
                if (!event) break;
                await this.processEvent.execute(event, this.workerId);
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

    private async sweep(): Promise<void> {
        if (this.sweeping) return;
        this.sweeping = true;
        try {
            await this.sweepLifecycle.execute();
        } catch (error) {
            this.logger.error({
                message: "Room lifecycle sweeper failed",
                err: error,
            });
        } finally {
            this.sweeping = false;
        }
    }
}
