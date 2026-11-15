import { PostgresProvider } from "@/shared/infrastructure/database/postgres.provider.js";
import {
    ConflictException,
    ForbiddenException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
} from "@nestjs/common";
import { MediaSessionService } from "../media-session-sfu/media-session.service.js";
import {
    LIVEKIT_CONFIG,
    type LiveKitConfig,
} from "@/shared/infrastructure/livekit/livekit.types.js";
import { LiveKitConnectionDto } from "./dto/livekit-connection.dto.js";
import { LiveKitTokenService } from "@/shared/infrastructure/livekit/livekit.token.service.js";
import { LiveKitInfrastructureService } from "@/shared/infrastructure/livekit/livekit.infrastructure.service.js";
import {
    MediaSession,
    MediaSessionRow,
    mapMediaSessionRow,
} from "../media-session-sfu/media-session.types.js";

/**
 * Service responsible for managing LiveKit media sessions, coordinating room infrastructure
 * lifecycles, and handling secure token generation for participants.
 */
@Injectable()
export class LiveKitService {
    private readonly logger = new Logger(LiveKitService.name);

    constructor(
        private readonly pg: PostgresProvider,
        private readonly mediaSessionService: MediaSessionService,
        private readonly liveKitTokenService: LiveKitTokenService,
        private readonly liveKitInfrasService: LiveKitInfrastructureService,
        @Inject(LIVEKIT_CONFIG)
        private readonly liveKitConfig: LiveKitConfig,
    ) {}

    /**
     * Creates a new media session for a watch room and immediately starts it.
     *
     * ### Workflow & Mechanism
     * 1. **Session Creation**: Invokes `mediaSessionService` to create a record in the `CREATED` state.
     * 2. **Session Activation**: Triggers `startMediaSession` to transition the session through
     *    `STARTING`, provision the LiveKit room, and activate it (`ACTIVE`).
     *
     * @param roomId The unique UUID of the watch room to create a media session for.
     * @returns A promise resolving with the fully activated `MediaSession` object.
     * @throws {Error} Throws if creation or startup sequence fails.
     */
    async createMediaSession(roomId: string): Promise<MediaSession> {
        const session =
            await this.mediaSessionService.createMediaSession(roomId);

        return await this.startMediaSession(session.id);
    }

    private readonly staleStartingSessionMs = 30_000;

    /**
     * Finds the room's nonterminal session or creates one when absent.\
     * A stale STARTING/ENDING session is cleaned up before a replacement is
     * attempted. Concurrent inserts still rely on PostgreSQL's partial unique
     * index as the final guard.
     */

    /**
     * Finds the room's nonterminal session or creates one when absent, featuring automatic
     * stale session recovery and race-condition handling.
     *
     * ### Workflow & Mechanism
     * 1. **Discovery / Creation Loop**: Tries to fetch an existing nonterminal session. If missing (`NotFoundException`),
     *    attempts to create a new one. Handles race conditions via PostgreSQL unique constraints.
     * 2. **Status Evaluation**:
     *    - If `ACTIVE`: Immediately returns the session.
     *    - If `CREATED`: Attempts to start the session. If starting fails, checks the latest state.
     *    - If `STARTING`: Checks age against a 30-second staleness threshold (`staleStartingSessionMs`).
     *      If stale, triggers teardown (`endMediaSessionById`); otherwise throws a conflict.
     *    - If `ENDING`: Resumes idempotent teardown.
     * 3. **Retry Loop**: Loops up to 3 attempts to allow PostgreSQL serialization and cleanup completion.
     *
     * @param roomId The unique UUID of the watch room.
     * @returns A promise resolving with a valid, active or starting `MediaSession`.
     * @throws {ConflictException} Throws if sessions are stuck starting or if setup fails after recovery attempts.
     */
    async getOrCreateMediaSession(roomId: string): Promise<MediaSession> {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            let session: MediaSession;

            try {
                session =
                    await this.mediaSessionService.getMediaSessionByRoomId(
                        roomId,
                    );
            } catch (error) {
                if (!(error instanceof NotFoundException)) {
                    throw error;
                }

                try {
                    session =
                        await this.mediaSessionService.createMediaSession(
                            roomId,
                        );
                } catch (createError) {
                    const postgresCode = this.getPostgresErrorCode(createError);
                    const isPotentialCreateRace =
                        createError instanceof ConflictException ||
                        postgresCode === "23505";

                    if (!isPotentialCreateRace) {
                        throw createError;
                    }

                    try {
                        session =
                            await this.mediaSessionService.getMediaSessionByRoomId(
                                roomId,
                            );
                    } catch {
                        // Preserve the original creation error if no competing session exists.
                        throw createError;
                    }
                }
            }

            if (session.status === "ACTIVE") {
                await this.assertRoomActive(roomId);
                return session;
            }

            if (session.status === "CREATED") {
                try {
                    return await this.startMediaSession(session.id);
                } catch (startError) {
                    let latestSession: MediaSession;
                    try {
                        latestSession =
                            await this.mediaSessionService.getMediaSession(
                                session.id,
                            );
                    } catch {
                        throw startError;
                    }

                    if (latestSession.status === "ACTIVE") {
                        return latestSession;
                    }

                    if (latestSession.status === "STARTING") {
                        const ageMs =
                            Date.now() -
                            new Date(latestSession.createdAt).getTime();
                        if (ageMs < this.staleStartingSessionMs) {
                            throw startError;
                        }
                    } else if (latestSession.status !== "ENDING") {
                        throw startError;
                    }

                    // A concurrent starter failed or this session has been stuck
                    // past the startup grace period. Resume idempotent teardown.
                    await this.endMediaSessionById(session.id);
                }
            } else if (session.status === "STARTING") {
                const ageMs =
                    Date.now() - new Date(session.createdAt).getTime();
                if (ageMs < this.staleStartingSessionMs) {
                    throw new ConflictException(
                        "The room's LiveKit media session is still starting. Retry the connection shortly.",
                    );
                }

                await this.endMediaSessionById(session.id);
            } else if (session.status === "ENDING") {
                await this.endMediaSessionById(session.id);
            }

            // The prior nonterminal session was cleaned up. Loop and create or
            // discover the next session, while allowing PostgreSQL to serialize races.
        }

        throw new ConflictException(
            "Unable to establish a LiveKit media session after several recovery attempts.",
        );
    }

    /**
     * Safely extracts the error code string from an unknown database or driver exception object.
     *
     * @param error An unknown error object caught during execution.
     * @returns The string error code if present (e.g., PostgreSQL error code `"23505"`), or `undefined` otherwise.
     */
    private getPostgresErrorCode(error: unknown): string | undefined {
        if (typeof error !== "object" || error === null || !("code" in error)) {
            return undefined;
        }

        const code = (error as { code?: unknown }).code;
        return typeof code === "string" ? code : undefined;
    }

    /**
     * Looks up and ends the current nonterminal session for a room.
     * Room shutdown uses this entry point after the room is made inactive.
     *
     * @param roomId The unique UUID of the watch room being shut down.
     * @returns A promise that resolves when the session teardown sequence completes or if no session is found.
     */
    async endMediaSessionForRoom(roomId: string): Promise<void> {
        let session: MediaSession;

        try {
            session =
                await this.mediaSessionService.getMediaSessionByRoomId(roomId);
        } catch (error) {
            if (error instanceof NotFoundException) {
                return;
            }
            throw error;
        }

        await this.endMediaSessionById(session.id);
    }

    /**
     * Creates or returns the room's media session on behalf of an authenticated
     * caller, who must be an active member of the ACTIVE room.
     */
    async getOrCreateMediaSessionForMember(
        roomId: string,
        userId: string,
    ): Promise<MediaSession> {
        const membership = await this.pg.query(
            `SELECT rp.id
             FROM public.room_participants rp
             INNER JOIN public.rooms r ON r.id = rp.room_id
             WHERE rp.room_id = $1 AND rp.user_id = $2
               AND rp.is_active = true AND r.lifecycle_status = 'ACTIVE'
             LIMIT 1`,
            [roomId, userId],
        );
        if (!membership.rows[0]) {
            throw new ForbiddenException(
                "Only active members of an active room can start its media session.",
            );
        }
        return this.getOrCreateMediaSession(roomId);
    }

    /**
     * Removes provider participants that no longer hold an active membership.
     * Identities are membership ids (`room_participants.id`), so a departed
     * member's old identity is always absent from the allowed set.
     * `loadAllowedIdentities` is called AFTER listing provider participants: a
     * listed participant connected with a token that required a committed
     * membership, so reading memberships later can never miss them.
     * Absolute reconciliation: safe to repeat after any crash or retry.
     */
    async reconcileRoomParticipants(
        roomId: string,
        loadAllowedIdentities: () => Promise<ReadonlySet<string>>,
    ): Promise<void> {
        let session: MediaSession;
        try {
            session =
                await this.mediaSessionService.getMediaSessionByRoomId(roomId);
        } catch (error) {
            if (error instanceof NotFoundException) return;
            throw error;
        }
        if (session.status !== "ACTIVE") return;

        let participants;
        try {
            participants = await this.liveKitInfrasService.listParticipants(
                session.id,
            );
        } catch (error) {
            if (this.isProviderNotFound(error)) return;
            throw error;
        }

        if (participants.length === 0) return;
        const allowedIdentities = await loadAllowedIdentities();

        for (const participant of participants) {
            if (allowedIdentities.has(participant.identity)) continue;
            try {
                await this.liveKitInfrasService.removeParticipant(
                    session.id,
                    participant.identity,
                );
                this.logger.log({
                    message:
                        "Removed LiveKit participant without an active room membership",
                    mediaSessionId: session.id,
                    roomId,
                    participantIdentity: participant.identity,
                });
            } catch (error) {
                if (!this.isProviderNotFound(error)) throw error;
            }
        }
    }

    /** Reconciles a durable startup event after a process restart. */
    async reconcileMediaSession(
        mediaSessionId: string,
        recoveryStartedAt: Date | string,
    ): Promise<void> {
        let session: MediaSession;
        try {
            session =
                await this.mediaSessionService.getMediaSession(mediaSessionId);
        } catch (error) {
            // The row was removed (e.g. cascade delete); nothing left to converge.
            if (error instanceof NotFoundException) return;
            throw error;
        }
        if (session.status === "ACTIVE") return;
        if (session.status === "CREATED") {
            // A CREATED session for a room that is no longer ACTIVE can never start.
            const room = await this.pg.query(
                `SELECT 1 FROM public.rooms WHERE id = $1 AND lifecycle_status = 'ACTIVE'`,
                [session.roomId],
            );
            if (!room.rows[0]) {
                await this.endMediaSessionById(mediaSessionId);
            }
            return;
        }
        if (session.status === "ENDED") {
            // Startup may have completed provider creation after a concurrent
            // termination already marked this exact session ENDED.
            await this.deleteLiveKitRoomIfPresent(mediaSessionId);
            return;
        }
        if (session.status === "ENDING") {
            await this.endMediaSessionById(mediaSessionId);
            return;
        }
        if (session.status === "STARTING") {
            const ageMs = Date.now() - new Date(recoveryStartedAt).getTime();
            if (ageMs < this.staleStartingSessionMs) {
                throw new ConflictException(
                    "LiveKit startup is still within its recovery window.",
                );
            }
            // A crashed/ambiguous startup is converged by deleting this exact provider generation.
            await this.endMediaSessionById(mediaSessionId);
        }
    }

    /**
     * Ends one exact media-session generation. Retries never look up a newer
     * session by room ID, so an old cleanup cannot terminate a replacement.
     */

    /**
     * Ends an exact media session generation idempotently, handling state transitions,
     * LiveKit infrastructure room deletion, and retry guards.
     *
     * ### Workflow & Mechanism
     * 1. **Idempotency Check**: Returns early if the session is already `ENDED`.
     * 2. **State Transition**: Moves session to `ENDING` (with retry protection and fallbacks for concurrent modifications).
     * 3. **Infrastructure Cleanup**: Deletes the underlying LiveKit room via `deleteLiveKitRoomIfPresent`.
     * 4. **Completion**: Marks the media session as complete (`ENDED`).
     *
     * @param mediaSessionId The unique UUID of the media session to terminate.
     * @returns A promise that resolves when termination completes successfully.
     * @throws {ConflictException} Throws if the session cannot be terminated due to an invalid state.
     */
    async endMediaSessionById(mediaSessionId: string): Promise<void> {
        let session =
            await this.mediaSessionService.getMediaSession(mediaSessionId);

        if (session.status === "ENDED") {
            return;
        }

        let shouldDeleteProviderRoom =
            session.status === "STARTING" ||
            session.status === "ACTIVE" ||
            session.status === "ENDING";

        if (session.status !== "ENDING") {
            try {
                session = await this.markLiveKitSessionEnding(mediaSessionId);
            } catch (transitionError) {
                // Another lifecycle operation may have changed this same
                // session after our read. Re-read and retry the guarded transition.
                const latestSession =
                    await this.mediaSessionService.getMediaSession(
                        mediaSessionId,
                    );

                if (latestSession.status === "ENDED") {
                    return;
                }

                if (latestSession.status === "ENDING") {
                    session = latestSession;
                    shouldDeleteProviderRoom = true;
                } else if (
                    latestSession.status === "CREATED" ||
                    latestSession.status === "STARTING" ||
                    latestSession.status === "ACTIVE"
                ) {
                    shouldDeleteProviderRoom =
                        latestSession.status !== "CREATED";
                    try {
                        session =
                            await this.markLiveKitSessionEnding(mediaSessionId);
                    } catch (retryTransitionError) {
                        const finalSession =
                            await this.mediaSessionService.getMediaSession(
                                mediaSessionId,
                            );
                        if (finalSession.status === "ENDED") {
                            return;
                        }
                        if (finalSession.status !== "ENDING") {
                            throw retryTransitionError;
                        }
                        session = finalSession;
                        shouldDeleteProviderRoom = true;
                    }
                } else {
                    throw transitionError;
                }
            }
        }

        if (session.status === "ENDED") {
            return;
        }

        if (session.status !== "ENDING") {
            throw new ConflictException(
                `Cannot terminate LiveKit media session from status ${session.status}.`,
            );
        }

        if (shouldDeleteProviderRoom) {
            try {
                await this.deleteLiveKitRoomIfPresent(session.id);
            } catch (error) {
                this.logger.warn({
                    message:
                        "LiveKit room deletion during cleanup failed; session remains ENDING for retry",
                    mediaSessionId: session.id,
                    err: error,
                });
                throw error;
            }
        }

        try {
            await this.mediaSessionService.completeMediaSession(session.id);
        } catch (completionError) {
            const latestSession =
                await this.mediaSessionService.getMediaSession(session.id);
            if (latestSession.status !== "ENDED") {
                throw completionError;
            }
        }
    }

    /**
     * Creates a secure client connection token for an active media session after validating
     * that the user is an authorized participant of the room.
     *
     * ### Workflow & Mechanism
     * 1. **Session State Check**: Verifies that the media session is currently `ACTIVE`.
     * 2. **Participant Verification**: Queries PostgreSQL to ensure the requesting user is an
     *    active member/participant of the session's associated room.
     * 3. **Token Generation**: Generates a cryptographically signed LiveKit participant token
     *    with publish/subscribe privileges enabled.
     *
     * @param mediaSessionId The unique UUID of the target media session.
     * @param userId The unique UUID of the user requesting the connection token.
     * @returns A promise resolving with the `LiveKitConnectionDto` containing server URL and participant token.
     * @throws {ConflictException} Throws if the media session is not active.
     * @throws {NotFoundException} Throws if the user is not a participant of the room.
     */
    async createMediaSessionConnection(
        mediaSessionId: string,
        userId: string,
    ): Promise<LiveKitConnectionDto> {
        const session =
            await this.mediaSessionService.getMediaSession(mediaSessionId);

        if (session.status !== "ACTIVE") {
            throw new ConflictException(
                `MediaSession cannot be connected from status ${session.status}.`,
            );
        }

        const participantQuery = `
            SELECT
                rp.id AS participant_id,
                rp.user_id,
                rp.room_id
            FROM public.room_participants rp
            INNER JOIN public.rooms r ON r.id = rp.room_id
            WHERE rp.room_id = $1
            AND rp.user_id = $2
            AND rp.is_active = true
            AND r.lifecycle_status = 'ACTIVE'
            LIMIT 1
        `;

        const participant = await this.pg.query<{
            participant_id: string;
            user_id: string;
            room_id: string;
        }>(participantQuery, [session.roomId, userId]);

        if (!participant || participant.rows.length < 1) {
            throw new NotFoundException(
                "The authenticated user is not a participant of the MediaSession room.",
            );
        }

        const participantId = participant.rows[0].participant_id;

        const participantToken =
            await this.liveKitTokenService.createParticipantToken({
                roomName: session.id,
                participantIdentity: participantId,
                // Short-lived: the token is only needed to (re)join. Connected
                // clients receive refreshed tokens from LiveKit, while a member whose
                // membership ended cannot reuse an old token for long. Removal from
                // the provider room is enforced by ROOM_RECONCILE.
                ttl: "10m",
                canPublish: true,
                canSubscribe: true,
                canPublishData: true,
            });

        return {
            mediaSessionId: session.id,
            participantId,
            serverUrl: this.liveKitConfig.url,
            participantToken,
        };
    }

    /**
     * Deletes a room from the LiveKit provider infrastructure if present, gracefully swallowing
     * 404/not found errors to ensure idempotent cleanup.
     *
     * @param roomName The unique name/identifier of the LiveKit room to delete.
     * @returns A promise that resolves when deletion completes or if the room is already missing.
     * @throws {Error} Throws if provider deletion fails with an unexpected error code or message.
     */
    private async deleteLiveKitRoomIfPresent(roomName: string): Promise<void> {
        try {
            await this.liveKitInfrasService.deleteRoom(roomName);
        } catch (error) {
            if (this.isProviderNotFound(error)) {
                return;
            }

            throw error;
        }
    }

    private isProviderNotFound(error: unknown): boolean {
        const providerError = error as {
            statusCode?: number;
            status?: number;
            code?: number | string;
            message?: string;
        };
        return (
            providerError?.statusCode === 404 ||
            providerError?.status === 404 ||
            providerError?.code === 404 ||
            providerError?.code === "NOT_FOUND" ||
            providerError?.code === "not_found" ||
            /(room|participant).*(not found|does not exist)/i.test(
                providerError?.message ?? "",
            )
        );
    }

    /**
     * Transitions a created media session into a running state by provisioning a corresponding
     * room on the LiveKit server infrastructure.
     *
     * ### Workflow & Mechanism
     * 1. **Status Verification**: Checks that the session is in the `CREATED` state.
     * 2. **Room Validation**: Queries PostgreSQL to verify the watch room exists and is active, retrieving its capacity limit.
     * 3. **Infrastructure Provisioning**: Transitions the session to `STARTING`, provisions the room in LiveKit,
     *    and activates the session (`ACTIVE`).
     *
     * @param mediaSessionId The unique UUID of the media session to start.
     * @returns A promise resolving with the updated, active `MediaSession`.
     * @throws {ConflictException} Throws if the session cannot start from its current status.
     * @throws {NotFoundException} Throws if the underlying watch room does not exist or is inactive.
     */
    async startMediaSession(mediaSessionId: string): Promise<MediaSession> {
        const session =
            await this.mediaSessionService.getMediaSession(mediaSessionId);

        if (session.status !== "CREATED") {
            throw new ConflictException(
                `MediaSession cannot start from status ${session.status}.`,
            );
        }

        const roomQuery = `
            SELECT
                id,
                max_participants
            FROM public.rooms
            WHERE id = $1
            AND lifecycle_status = 'ACTIVE'
            LIMIT 1
        `;

        const room = await this.pg.query<{
            id: string;
            max_participants: number;
        }>(roomQuery, [session.roomId]);

        if (!room || room.rows.length < 1) {
            throw new NotFoundException(
                "The MediaSession watch room does not exist or is inactive.",
            );
        }

        const startingSession = await this.startLiveKitSession(
            mediaSessionId,
            room.rows[0].id,
        );

        try {
            await this.liveKitInfrasService.createRoom(
                startingSession.id,
                room.rows[0].max_participants,
            );

            return await this.activateLiveKitSession(
                mediaSessionId,
                startingSession.roomId,
            );
        } catch (error) {
            // The room may have begun termination while provider creation was in flight.
            // Cleanup addresses this exact media-session generation, never a replacement.
            try {
                await this.endMediaSessionById(mediaSessionId);
            } catch (cleanupError) {
                this.logger.warn({
                    message:
                        "Failed to clean up LiveKit room after startup did not activate",
                    mediaSessionId,
                    err: cleanupError,
                });
            }
            // The termination worker may have deleted the provider room before an
            // in-flight createRoom call completed. Delete once more after creation
            // has settled, even if the database session is already ENDED.
            try {
                await this.deleteLiveKitRoomIfPresent(mediaSessionId);
            } catch (providerCleanupError) {
                this.logger.warn({
                    message:
                        "LiveKit provider room may require outbox retry after startup failure",
                    mediaSessionId,
                    err: providerCleanupError,
                });
            }
            throw error;
        }
    }

    private async assertRoomActive(roomId: string): Promise<void> {
        const result = await this.pg.query(
            `SELECT id FROM public.rooms WHERE id = $1 AND lifecycle_status = 'ACTIVE' LIMIT 1`,
            [roomId],
        );
        if (!result.rows[0]) {
            throw new ConflictException(
                "The watch room is no longer accepting media connections.",
            );
        }
    }

    private async startLiveKitSession(
        mediaSessionId: string,
        roomId: string,
    ): Promise<MediaSession> {
        const result = await this.pg.withTransaction(async (client) => {
            const room = await client.query(
                `SELECT id FROM public.rooms
                 WHERE id = $1 AND lifecycle_status = 'ACTIVE'
                 FOR UPDATE`,
                [roomId],
            );
            if (!room.rows[0]) {
                throw new ConflictException(
                    "Cannot start LiveKit for a room that is no longer ACTIVE.",
                );
            }
            const updated = await client.query<MediaSessionRow>(
                `UPDATE public.media_sessions SET status = 'STARTING'
                 WHERE id = $1 AND room_id = $2 AND status = 'CREATED'
                 RETURNING id, room_id, status, assigned_sfu_node_id, created_at, started_at, ended_at`,
                [mediaSessionId, roomId],
            );
            if (!updated.rows[0]) {
                throw new ConflictException(
                    "MediaSession state changed before LiveKit startup.",
                );
            }
            // Recovery for a crashed startup is only needed after the 30 s startup
            // window; claiming it earlier just fails and burns retry attempts.
            await client.query(
                `INSERT INTO public.room_lifecycle_outbox (event_type, aggregate_id, next_attempt_at)
                 VALUES ('LIVEKIT_SESSION_RECONCILE', $1, NOW() + INTERVAL '35 seconds')`,
                [mediaSessionId],
            );
            return updated.rows[0];
        });
        return mapMediaSessionRow(result);
    }

    private async activateLiveKitSession(
        mediaSessionId: string,
        roomId: string,
    ): Promise<MediaSession> {
        const result = await this.pg.withTransaction(async (client) => {
            const room = await client.query(
                `SELECT id FROM public.rooms
                 WHERE id = $1 AND lifecycle_status = 'ACTIVE'
                 FOR UPDATE`,
                [roomId],
            );
            if (!room.rows[0]) {
                throw new ConflictException(
                    "The watch room began termination before LiveKit activation.",
                );
            }
            const updated = await client.query<MediaSessionRow>(
                `UPDATE public.media_sessions
                 SET status = 'ACTIVE', started_at = COALESCE(started_at, NOW())
                 WHERE id = $1 AND room_id = $2 AND status = 'STARTING'
                 RETURNING id, room_id, status, assigned_sfu_node_id, created_at, started_at, ended_at`,
                [mediaSessionId, roomId],
            );
            if (!updated.rows[0]) {
                throw new ConflictException(
                    "MediaSession cannot activate from its current state.",
                );
            }
            return updated.rows[0];
        });
        return mapMediaSessionRow(result);
    }

    private async markLiveKitSessionEnding(
        mediaSessionId: string,
    ): Promise<MediaSession> {
        const result = await this.pg.withTransaction(async (client) => {
            const updated = await client.query<MediaSessionRow>(
                `UPDATE public.media_sessions
                 SET status = 'ENDING'
                 WHERE id = $1 AND status IN ('CREATED', 'STARTING', 'ACTIVE')
                 RETURNING id, room_id, status, assigned_sfu_node_id, created_at, started_at, ended_at`,
                [mediaSessionId],
            );
            if (!updated.rows[0]) {
                throw new ConflictException(
                    "MediaSession state changed before LiveKit termination.",
                );
            }
            await client.query(
                `INSERT INTO public.room_lifecycle_outbox (event_type, aggregate_id)
                 VALUES ('LIVEKIT_SESSION_RECONCILE', $1)`,
                [mediaSessionId],
            );
            return updated.rows[0];
        });
        return mapMediaSessionRow(result);
    }
}
