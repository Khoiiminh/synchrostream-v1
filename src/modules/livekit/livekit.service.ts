import { Inject, Injectable, Logger } from "@nestjs/common";
import type { MediaSession } from "./domain/media-session.js";
import type { MediaSessionStore } from "./application/ports/media-session-store.port.js";
import type {
    MediaProviderPort,
    ParticipantTokenPort,
    RoomAccessPort,
} from "./application/ports/collaborators.port.js";
import {
    MEDIA_PROVIDER,
    MEDIA_SESSION_STORE,
    PARTICIPANT_TOKENS,
    ROOM_ACCESS,
} from "./application/ports/tokens.js";
import { MediaSessionRecords } from "./application/use-cases/session-records.js";
import { EndMediaSession } from "./application/use-cases/end-media-session.js";
import { StartMediaSession } from "./application/use-cases/start-media-session.js";
import { GetOrCreateMediaSession } from "./application/use-cases/get-or-create-media-session.js";
import { ReconcileMediaSession } from "./application/use-cases/reconcile-media-session.js";
import {
    IssueMediaConnection,
    type MediaConnection,
} from "./application/use-cases/issue-connection.js";
import type { LiveKitMediaSessions } from "./queries/livekit-media-sessions.js";
import { withHttpErrors } from "./presentation/error-mapper.js";

/**
 * The LiveKit media-session facade used by the controller and, through the
 * LIVEKIT_MEDIA_SESSIONS contract, by watch-party. It builds the use cases
 * from the ports and converts domain errors to the HTTP exceptions callers
 * have always received.
 */
@Injectable()
export class LiveKitService implements LiveKitMediaSessions {
    private readonly start: StartMediaSession;
    private readonly end: EndMediaSession;
    private readonly getOrCreate: GetOrCreateMediaSession;
    private readonly reconcile: ReconcileMediaSession;
    private readonly connect: IssueMediaConnection;

    constructor(
        @Inject(MEDIA_SESSION_STORE) store: MediaSessionStore,
        @Inject(ROOM_ACCESS) rooms: RoomAccessPort,
        @Inject(MEDIA_PROVIDER) provider: MediaProviderPort,
        @Inject(PARTICIPANT_TOKENS) tokens: ParticipantTokenPort,
    ) {
        const logger = new Logger(LiveKitService.name);
        // Record logs keep the name they had before the B2 split.
        const records = new MediaSessionRecords(
            store,
            rooms,
            new Logger("MediaSessionService"),
        );
        this.end = new EndMediaSession(records, store, provider, logger);
        this.start = new StartMediaSession(
            records,
            store,
            rooms,
            provider,
            this.end,
            logger,
        );
        this.getOrCreate = new GetOrCreateMediaSession(
            records,
            rooms,
            this.start,
            this.end,
        );
        this.reconcile = new ReconcileMediaSession(
            records,
            rooms,
            provider,
            this.end,
            logger,
        );
        this.connect = new IssueMediaConnection(records, rooms, tokens);
    }

    getOrCreateMediaSession(roomId: string): Promise<MediaSession> {
        return withHttpErrors(() => this.getOrCreate.execute(roomId));
    }

    getOrCreateMediaSessionForMember(
        roomId: string,
        userId: string,
    ): Promise<MediaSession> {
        return withHttpErrors(() => this.getOrCreate.forMember(roomId, userId));
    }

    startMediaSession(mediaSessionId: string): Promise<MediaSession> {
        return withHttpErrors(() => this.start.execute(mediaSessionId));
    }

    endMediaSessionForRoom(roomId: string): Promise<void> {
        return withHttpErrors(() => this.end.forRoom(roomId));
    }

    endMediaSessionById(mediaSessionId: string): Promise<void> {
        return withHttpErrors(() => this.end.byId(mediaSessionId));
    }

    reconcileMediaSession(
        mediaSessionId: string,
        recoveryStartedAt: Date | string,
    ): Promise<void> {
        return withHttpErrors(() =>
            this.reconcile.session(mediaSessionId, recoveryStartedAt),
        );
    }

    reconcileRoomParticipants(
        roomId: string,
        loadAllowedIdentities: () => Promise<ReadonlySet<string>>,
    ): Promise<void> {
        return withHttpErrors(() =>
            this.reconcile.participants(roomId, loadAllowedIdentities),
        );
    }

    createMediaSessionConnection(
        mediaSessionId: string,
        userId: string,
    ): Promise<MediaConnection> {
        return withHttpErrors(() =>
            this.connect.execute(mediaSessionId, userId),
        );
    }
}
