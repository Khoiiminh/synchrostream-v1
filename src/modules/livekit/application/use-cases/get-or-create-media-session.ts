import {
    isPastStartupWindow,
    type MediaSession,
} from "../../domain/media-session.js";
import {
    MESSAGES,
    MediaConflict,
    MediaForbidden,
    MediaNotFound,
} from "../../domain/errors.js";
import { OpenSessionConflict } from "../ports/media-session-store.port.js";
import type { RoomAccessPort } from "../ports/collaborators.port.js";
import type { MediaSessionRecords } from "./session-records.js";
import type { StartMediaSession } from "./start-media-session.js";
import type { EndMediaSession } from "./end-media-session.js";

const ATTEMPTS = 3;

/**
 * Returns the room's ACTIVE session, starting or replacing one as needed.
 *
 *   ACTIVE   → returned (if the room is still ACTIVE)
 *   CREATED  → started; if that fails, a stuck session is ended and replaced
 *   STARTING → 409 inside the startup window, else ended and replaced
 *   ENDING   → teardown finished, then replaced
 *
 * Loops a few times so concurrent requests serialize on the unique index.
 */
export class GetOrCreateMediaSession {
    constructor(
        private readonly records: MediaSessionRecords,
        private readonly rooms: RoomAccessPort,
        private readonly start: StartMediaSession,
        private readonly end: EndMediaSession,
    ) {}

    /** For an authenticated caller, who must be an active member of the ACTIVE room. */
    async forMember(roomId: string, userId: string): Promise<MediaSession> {
        const membershipId = await this.rooms.findActiveMembershipId(
            roomId,
            userId,
        );
        if (!membershipId) {
            throw new MediaForbidden(MESSAGES.notActiveMember);
        }
        return this.execute(roomId);
    }

    async execute(roomId: string): Promise<MediaSession> {
        for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
            const session = await this.findOrCreate(roomId);

            if (session.status === "ACTIVE") {
                await this.assertRoomActive(roomId);
                return session;
            }

            if (session.status === "CREATED") {
                try {
                    return await this.start.execute(session.id);
                } catch (startError) {
                    let latestSession: MediaSession;
                    try {
                        latestSession = await this.records.get(session.id);
                    } catch {
                        throw startError;
                    }

                    if (latestSession.status === "ACTIVE") {
                        return latestSession;
                    }

                    if (latestSession.status === "STARTING") {
                        if (!isPastStartupWindow(latestSession.createdAt)) {
                            throw startError;
                        }
                    } else if (latestSession.status !== "ENDING") {
                        throw startError;
                    }

                    // A concurrent starter failed or this session has been stuck
                    // past the startup window. Resume idempotent teardown.
                    await this.end.byId(session.id);
                }
            } else if (session.status === "STARTING") {
                if (!isPastStartupWindow(session.createdAt)) {
                    throw new MediaConflict(MESSAGES.stillStarting);
                }

                await this.end.byId(session.id);
            } else if (session.status === "ENDING") {
                await this.end.byId(session.id);
            }

            // The prior open session was cleaned up. Loop and create or
            // discover the next one.
        }

        throw new MediaConflict(MESSAGES.recoveryExhausted);
    }

    /** The room's open session, creating one if absent; a lost create race reads the winner. */
    private async findOrCreate(roomId: string): Promise<MediaSession> {
        try {
            return await this.records.getByRoomId(roomId);
        } catch (error) {
            if (!(error instanceof MediaNotFound)) {
                throw error;
            }
        }

        try {
            return await this.records.create(roomId);
        } catch (createError) {
            const isPotentialCreateRace =
                createError instanceof MediaConflict ||
                createError instanceof OpenSessionConflict;

            if (!isPotentialCreateRace) {
                throw createError;
            }

            try {
                return await this.records.getByRoomId(roomId);
            } catch {
                // No competing session: keep the original creation error.
                throw createError;
            }
        }
    }

    private async assertRoomActive(roomId: string): Promise<void> {
        const activeRoomId = await this.rooms.findActiveRoomId(roomId);
        if (!activeRoomId) {
            throw new MediaConflict(MESSAGES.roomNotAcceptingMedia);
        }
    }
}
