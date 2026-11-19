/*
 * Conflicts a store reports instead of driver errors. The Postgres adapter
 * raises them from unique violations; use cases decide what they mean
 * (retry a generated code, look up the room that won a race, ...).
 */

/** The room code is reserved by another non-TERMINATED room. */
export class RoomCodeConflict extends Error {
    constructor(options?: { cause?: unknown }) {
        super("Room code is already reserved.", options);
        this.name = "RoomCodeConflict";
    }
}

/** The user already has an active membership in some room. */
export class ActiveMembershipConflict extends Error {
    constructor(options?: { cause?: unknown }) {
        super("User already has an active room membership.", options);
        this.name = "ActiveMembershipConflict";
    }
}
