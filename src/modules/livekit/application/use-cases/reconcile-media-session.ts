import {
    isPastStartupWindow,
    type MediaSession,
} from "../../domain/media-session.js";
import { MESSAGES, MediaConflict, MediaNotFound } from "../../domain/errors.js";
import type {
    LiveKitLogger,
    MediaProviderPort,
    RoomAccessPort,
} from "../ports/collaborators.port.js";
import type { MediaSessionRecords } from "./session-records.js";
import type { EndMediaSession } from "./end-media-session.js";

/** Convergence run by the watch-party outbox worker; safe to repeat. */
export class ReconcileMediaSession {
    constructor(
        private readonly records: MediaSessionRecords,
        private readonly rooms: RoomAccessPort,
        private readonly provider: MediaProviderPort,
        private readonly end: EndMediaSession,
        private readonly logger: LiveKitLogger,
    ) {}

    /** Reconciles a durable LIVEKIT_SESSION_RECONCILE event after a restart. */
    async session(
        mediaSessionId: string,
        recoveryStartedAt: Date | string,
    ): Promise<void> {
        let session: MediaSession;
        try {
            session = await this.records.get(mediaSessionId);
        } catch (error) {
            // The row was removed (e.g. cascade delete); nothing left to converge.
            if (error instanceof MediaNotFound) return;
            throw error;
        }
        if (session.status === "ACTIVE") return;
        if (session.status === "CREATED") {
            // A CREATED session for a room that is no longer ACTIVE can never start.
            const roomIsActive = await this.rooms.isRoomActive(session.roomId);
            if (!roomIsActive) {
                await this.end.byId(mediaSessionId);
            }
            return;
        }
        if (session.status === "ENDED") {
            // Startup may have completed provider creation after a concurrent
            // termination already marked this exact session ENDED.
            await this.provider.deleteRoomIfPresent(mediaSessionId);
            return;
        }
        if (session.status === "ENDING") {
            await this.end.byId(mediaSessionId);
            return;
        }
        if (session.status === "STARTING") {
            if (!isPastStartupWindow(recoveryStartedAt)) {
                throw new MediaConflict(MESSAGES.stillInRecoveryWindow);
            }
            // A crashed or ambiguous startup is converged by deleting this
            // exact provider generation.
            await this.end.byId(mediaSessionId);
        }
    }

    /**
     * Removes provider participants that no longer hold an active membership.
     * Identities are membership ids (`room_participants.id`), so a departed
     * member's old identity is always absent from the allowed set.
     * `loadAllowedIdentities` is called AFTER listing provider participants: a
     * listed participant connected with a token that required a committed
     * membership, so reading memberships later can never miss them.
     */
    async participants(
        roomId: string,
        loadAllowedIdentities: () => Promise<ReadonlySet<string>>,
    ): Promise<void> {
        let session: MediaSession;
        try {
            session = await this.records.getByRoomId(roomId);
        } catch (error) {
            if (error instanceof MediaNotFound) return;
            throw error;
        }
        if (session.status !== "ACTIVE") return;

        const identities = await this.provider.listParticipantIdentities(
            session.id,
        );
        if (identities === null || identities.length === 0) return;
        const allowedIdentities = await loadAllowedIdentities();

        for (const identity of identities) {
            if (allowedIdentities.has(identity)) continue;
            const removed = await this.provider.removeParticipantIfPresent(
                session.id,
                identity,
            );
            if (removed) {
                this.logger.log({
                    message:
                        "Removed LiveKit participant without an active room membership",
                    mediaSessionId: session.id,
                    roomId,
                    participantIdentity: identity,
                });
            }
        }
    }
}
