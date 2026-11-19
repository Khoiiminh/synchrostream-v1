import type {
    IdRow,
    OutboxEvent,
    RoomCodeHolderRow,
    RoomProjectionRow,
} from "../../watch-party.types.js";
import type { Tx } from "./transaction.js";

/**
 * Persistence for the room lifecycle outbox, its sweeper and room
 * reconciliation. Implemented by
 * infrastructure/persistence/room-lifecycle-outbox.repository.ts.
 *
 * Lifecycle transitions are guarded by the observed `state_version`, so a
 * stale reconciliation updates nothing (rowCount 0).
 */
export interface OutboxStore {
    withTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;

    // Events
    enqueueRoomReconciliation(tx: Tx | undefined, roomId: string): Promise<void>;
    /** Leases the oldest due event (or one whose lease expired). */
    claimNextEvent(
        tx: Tx | undefined,
        workerId: string,
        leaseSeconds: number,
    ): Promise<OutboxEvent | null>;
    markEventCompleted(eventId: string, workerId: string): Promise<void>;
    /** Releases the lease and reschedules the event, or parks it as DEAD. */
    markEventFailed(
        eventId: string,
        workerId: string,
        delaySeconds: number,
        lastError: string,
        deadLetter: boolean,
    ): Promise<void>;

    // Sweeper
    /** Transaction-scoped: one instance sweeps per tick. */
    tryAcquireSweeperLock(tx: Tx | undefined): Promise<boolean>;
    terminateTimedOutProvisioningRooms(
        tx: Tx | undefined,
        timeoutMinutes: number,
    ): Promise<IdRow[]>;
    deactivateActiveParticipants(tx: Tx | undefined, roomId: string): Promise<void>;
    requeueUnconvergedRooms(tx: Tx | undefined): Promise<number | null>;
    requeueStuckMediaSessions(
        tx: Tx | undefined,
        stuckMinutes: number,
    ): Promise<number | null>;
    pruneCompletedEvents(
        tx: Tx | undefined,
        retentionDays: number,
    ): Promise<number | null>;

    // Reconciliation
    findRoomProjection(roomId: string): Promise<RoomProjectionRow | undefined>;
    /** PROVISIONING → ACTIVE at `stateVersion`; returns rowCount. */
    activateProvisioningRoom(
        tx: Tx | undefined,
        roomId: string,
        stateVersion: string,
    ): Promise<number | null>;
    /** TERMINATING → TERMINATED at `stateVersion`; returns rowCount. */
    markRoomTerminated(
        tx: Tx | undefined,
        roomId: string,
        stateVersion: string,
    ): Promise<number | null>;
    listActiveParticipantIds(roomId: string): Promise<IdRow[]>;
    findRoomCodeHolder(roomId: string): Promise<RoomCodeHolderRow | undefined>;
}
