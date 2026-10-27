import { PostgresProvider } from "@/shared/infrastructure/database/postgres.provider.js";
import { ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { MediaSessionService } from "../media-session-sfu/media-session.service.js";
import { LIVEKIT_CONFIG, type LiveKitConfig } from "@/shared/infrastructure/livekit/livekit.types.js";
import { LiveKitConnectionDto } from "./dto/livekit-connection.dto.js";
import { LiveKitTokenService } from "@/shared/infrastructure/livekit/livekit.token.service.js";
import { LiveKitInfrastructureService } from "@/shared/infrastructure/livekit/livekit.infrastructure.service.js";
import { MediaSession } from "../media-session-sfu/media-session.types.js";

/**
 * Service responsible for managing LiveKit media sessions, coordinating room infrastructure 
 * lifecycles, and handling secure token generation for participants.
 */
@Injectable() 
export class LiveKitService {
    private readonly logger = new Logger(LiveKitService.name);

    constructor(
        private readonly pg: PostgresProvider,
        private  readonly mediaSessionService: MediaSessionService,
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
        const session = await this.mediaSessionService.createMediaSession(roomId);

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
                session = await this.mediaSessionService.getMediaSessionByRoomId(roomId);
            } catch (error) {
                if (!(error instanceof NotFoundException)) {
                    throw error;
                }

                try {
                    session = await this.mediaSessionService.createMediaSession(roomId);
                } catch (createError) {
                    const postgresCode = this.getPostgresErrorCode(createError);
                    const isPotentialCreateRace =
                        createError instanceof ConflictException || postgresCode === "23505";

                    if (!isPotentialCreateRace) {
                        throw createError;
                    }

                    try {
                        session = await this.mediaSessionService.getMediaSessionByRoomId(roomId);
                    } catch {
                        // Preserve the original creation error if no competing session exists.
                        throw createError;
                    }
                }
            }

            if (session.status === "ACTIVE") {
                return session;
            }

            if (session.status === "CREATED") {
                try {
                    return await this.startMediaSession(session.id);
                } catch (startError) {
                    let latestSession: MediaSession;
                    try {
                        latestSession = await this.mediaSessionService.getMediaSession(session.id);
                    } catch {
                        throw startError;
                    }

                    if (latestSession.status === "ACTIVE") {
                        return latestSession;
                    }

                    if (latestSession.status === "STARTING") {
                        const ageMs = Date.now() - new Date(latestSession.createdAt).getTime();
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
                const ageMs = Date.now() - new Date(session.createdAt).getTime();
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
            session = await this.mediaSessionService.getMediaSessionByRoomId(roomId);
        } catch (error) {
            if (error instanceof NotFoundException) {
                return;
            }
            throw error;
        }

        await this.endMediaSessionById(session.id);
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
        let session = await this.mediaSessionService.getMediaSession(mediaSessionId);

        if (session.status === "ENDED") {
            return;
        }

        let shouldDeleteProviderRoom =
            session.status === "STARTING" ||
            session.status === "ACTIVE" ||
            session.status === "ENDING";

        if (session.status !== "ENDING") {
            try {
                session = await this.mediaSessionService.endMediaSession(mediaSessionId);
            } catch (transitionError) {
                // Another lifecycle operation may have changed this same
                // session after our read. Re-read and retry the guarded transition.
                const latestSession = await this.mediaSessionService.getMediaSession(mediaSessionId);

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
                    shouldDeleteProviderRoom = latestSession.status !== "CREATED";
                    try {
                        session = await this.mediaSessionService.endMediaSession(mediaSessionId);
                    } catch (retryTransitionError) {
                        const finalSession = await this.mediaSessionService.getMediaSession(mediaSessionId);
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
                    message: "LiveKit room deletion during cleanup failed; session remains ENDING for retry",
                    mediaSessionId: session.id,
                    error: (error as Error).message,
                });
                throw error;
            }
        }

        try {
            await this.mediaSessionService.completeMediaSession(session.id);
        } catch (completionError) {
            const latestSession = await this.mediaSessionService.getMediaSession(session.id);
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
        userId: string
    ): Promise<LiveKitConnectionDto> {
        const session = await this.mediaSessionService.getMediaSession(mediaSessionId);

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
            WHERE rp.room_id = $1
            AND rp.user_id = $2
            LIMIT 1
        `;

        const participant = await this.pg.query<{
            participant_id: string;
            user_id: string;
            room_id: string;
        }>(
            participantQuery,
            [
                session.roomId,
                userId,
            ],
        );

        if (!participant || participant.rows.length < 1) {
            throw new NotFoundException(
                "The authenticated user is not a participant of the MediaSession room.",
            );
        }

        const participantId = participant.rows[0].participant_id;

        const participantToken = await this.liveKitTokenService.createParticipantToken({
            roomName: session.id,
            participantIdentity: participantId,
            canPublish: true,
            canSubscribe: true,
            canPublishData: true,
        });
        
        return {
            mediaSessionId: session.id,
            participantId,
            serverUrl: this.liveKitConfig.url,
            participantToken,
        }
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
            const providerError = error as {
                statusCode?: number;
                status?: number;
                code?: number | string;
                message?: string;
            };
            const isNotFound =
                providerError.statusCode === 404 ||
                providerError.status === 404 ||
                providerError.code === 404 ||
                providerError.code === "NOT_FOUND" ||
                /room.*(not found|does not exist)/i.test(providerError.message ?? "");

            if (isNotFound) {
                return;
            }

            throw error;
        }
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
        const session = await this.mediaSessionService.getMediaSession(mediaSessionId);

        if (session.status !== 'CREATED') {
            throw new ConflictException(`MediaSession cannot start from status ${session.status}.`);
        }

        const roomQuery = `
            SELECT
                id,
                max_participants
            FROM public.rooms
            WHERE id = $1
            AND is_active = true
            LIMIT 1
        `;

        const room = await this.pg.query<{
            id: string;
            max_participants: number;
        }>(roomQuery, [session.roomId]);

        if (!room || room.rows.length < 1) {
            throw new NotFoundException(
                "The MediaSession watch room does not exist or is inactive."
            );
        }

        const startingSession = await this.mediaSessionService.startMediaSession(mediaSessionId);

        try {
            await this.liveKitInfrasService.createRoom(
                startingSession.id,
                room.rows[0].max_participants,
            );

            return await this.mediaSessionService.activateMediaSession(mediaSessionId);

        } catch (error) {
            throw error;
        }
    }
}