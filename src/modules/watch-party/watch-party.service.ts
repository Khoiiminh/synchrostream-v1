import { Inject, Injectable, Logger } from "@nestjs/common";
import { JOIN_PASSWORD_RULE } from "@/shared/infrastructure/cache/attempt-limiter.js";
import type { WatchPartyStore } from "./application/ports/watch-party-store.port.js";
import type {
    AttemptLimiterPort,
    LifecycleOutboxPort,
    PasswordHasher,
} from "./application/ports/collaborators.port.js";
import {
    ATTEMPT_LIMITER,
    LIFECYCLE_OUTBOX,
    PASSWORD_HASHER,
    WATCH_PARTY_STORE,
} from "./application/ports/tokens.js";
import { CreateRoom } from "./application/use-cases/create-room.js";
import { JoinRoom } from "./application/use-cases/join-room.js";
import { LeaveRoom } from "./application/use-cases/leave-room.js";
import { ExpireMembership } from "./application/use-cases/expire-membership.js";
import { RoomQueries } from "./application/use-cases/room-queries.js";
import type {
    CreateRoomDto,
    JoinRoomDto,
} from "./presentation/dto/room.dto.js";
import { withHttpErrors } from "./presentation/error-mapper.js";

// Kept for existing importers (controller, gateway, specs).
export { CreateRoomDto, JoinRoomDto } from "./presentation/dto/room.dto.js";
export {
    ROOM_PASSWORD_MAX_LENGTH,
    ROOM_PASSWORD_MIN_LENGTH,
} from "./domain/room-password.js";

/**
 * Nest-facing facade of the watch-party use cases (phase 3).
 *
 * It owns no rules: each method delegates to one use case in
 * application/use-cases and turns the domain errors it throws into the HTTP
 * exceptions clients receive. The controller and gateway call this; the use
 * cases themselves import nothing from Nest.
 */
@Injectable()
export class WatchPartyService {
    private readonly createRoom: CreateRoom;
    private readonly joinRoom: JoinRoom;
    private readonly leaveRoom: LeaveRoom;
    private readonly expireMembership: ExpireMembership;
    private readonly queries: RoomQueries;

    constructor(
        @Inject(WATCH_PARTY_STORE) store: WatchPartyStore,
        @Inject(LIFECYCLE_OUTBOX) lifecycleOutbox: LifecycleOutboxPort,
        @Inject(ATTEMPT_LIMITER) attemptLimiter: AttemptLimiterPort,
        @Inject(PASSWORD_HASHER) passwords: PasswordHasher,
    ) {
        // One logger context for all use cases, so log lines read as before.
        const logger = new Logger(WatchPartyService.name);
        this.createRoom = new CreateRoom(
            store,
            lifecycleOutbox,
            passwords,
            logger,
        );
        this.joinRoom = new JoinRoom(
            store,
            lifecycleOutbox,
            attemptLimiter,
            passwords,
            JOIN_PASSWORD_RULE,
            logger,
        );
        this.leaveRoom = new LeaveRoom(store, lifecycleOutbox, logger);
        this.expireMembership = new ExpireMembership(
            store,
            lifecycleOutbox,
            logger,
        );
        this.queries = new RoomQueries(store, logger);
    }

    /** See CreateRoom. */
    createRoomSession(p: { dto: CreateRoomDto; ownerId: string }) {
        return withHttpErrors(() => this.createRoom.execute(p));
    }

    /** See JoinRoom. */
    associateParticipant(p: { dto: JoinRoomDto; userId: string }) {
        return withHttpErrors(() => this.joinRoom.execute(p));
    }

    /** See ExpireMembership (reconnection grace expired). */
    disassociateParticipant(participantId: string) {
        return withHttpErrors(() =>
            this.expireMembership.execute(participantId),
        );
    }

    /** See LeaveRoom. */
    leaveRoomSession(userId: string, roomId?: string) {
        return withHttpErrors(() => this.leaveRoom.execute(userId, roomId));
    }

    getRoomDetailsByCode(roomCode: string) {
        return withHttpErrors(() =>
            this.queries.getRoomDetailsByCode(roomCode),
        );
    }

    assertRoomActive(roomId: string): Promise<void> {
        return withHttpErrors(() => this.queries.assertRoomActive(roomId));
    }

    listActiveMemberships() {
        return withHttpErrors(() => this.queries.listActiveMemberships());
    }

    getRoomProjectionState(roomId: string) {
        return withHttpErrors(() =>
            this.queries.getRoomProjectionState(roomId),
        );
    }
}
