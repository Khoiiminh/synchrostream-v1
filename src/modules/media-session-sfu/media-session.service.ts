import { PostgresProvider } from "@/shared/infrastructure/database/postgres.provider.js";
import {
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
} from "@nestjs/common";
import {
    MediaSession,
    MediaSessionRow,
    mapMediaSessionRow,
} from "./media-session.types.js";

@Injectable()
export class MediaSessionService {
    private readonly logger = new Logger(MediaSessionService.name);

    constructor(private readonly pg: PostgresProvider) {}

    /**
     * Creates the control-plane representation of a media session.
     *
     * This method does NOT create an SFU runtime.
     * It only creates the authoritative MediaSession record in PostgreSQL.
     */
    async createMediaSession(roomId: string): Promise<MediaSession> {
        this.logger.debug({
            message: "Creating MediaSession",
            roomId,
        });

        /*
         * A room must exist and be active before a media session can be created.
         */
        const query = `SELECT 
             id, is_active
            FROM public.rooms
            WHERE id = $1`;

        const room = await this.pg.query<{
            id: string;
            is_active: boolean;
        }>(query, [roomId]);

        if (!room || room.rows.length < 1) {
            throw new NotFoundException(
                "The requested watch room does not exist.",
            );
        }

        if (!room.rows[0].is_active) {
            throw new ConflictException(
                "Cannot create a media session for an inactive room.",
            );
        }

        /*
         * The database already enforces the invariant that a room may have
         * at most one active-ish MediaSession through the partial unique index.
         *
         * We still check explicitly here so the API can return a meaningful
         * application-level error instead of relying solely on PostgreSQL.
         */
        const existingSessionQuery = `
            SELECT
                id,
                room_id,
                status,
                assigned_sfu_node_id,
                created_at,
                started_at,
                ended_at
            FROM public.media_sessions
            WHERE room_id = $1
              AND status IN (
                  'CREATED',
                  'STARTING',
                  'ACTIVE',
                  'ENDING'
              )
            LIMIT 1
        `;

        const existingRoom = await this.pg.query<MediaSessionRow>(
            existingSessionQuery,
            [roomId],
        );

        if (existingRoom.rows[0]) {
            throw new ConflictException(
                "The room already has an active media session.",
            );
        }

        try {
            /*
             * Insert only while the room is ACTIVE, holding a share lock on the
             * room row. Owner termination takes FOR UPDATE on the same row, so a
             * session is either created before termination (and then ended by the
             * termination worker) or not created at all. A plain is_active read
             * followed by INSERT could leave a CREATED session on a TERMINATED room.
             */
            const insertQuery = `
                INSERT INTO public.media_sessions (
                    room_id,
                    status
                )
                SELECT r.id, 'CREATED'
                FROM public.rooms r
                WHERE r.id = $1
                  AND r.lifecycle_status = 'ACTIVE'
                FOR SHARE
                RETURNING
                    id,
                    room_id,
                    status,
                    assigned_sfu_node_id,
                    created_at,
                    started_at,
                    ended_at
            `;

            const row = await this.pg.query<MediaSessionRow>(insertQuery, [
                roomId,
            ]);

            if (!row.rows[0]) {
                throw new ConflictException(
                    "Cannot create a media session for an inactive room.",
                );
            }

            const session = mapMediaSessionRow(row.rows[0]);

            this.logger.log({
                message: "MediaSession created successfully",
                mediaSessionId: session.id,
                roomId: session.roomId,
                status: session.status,
            });

            return session;
        } catch (error) {
            /*
             * The PostgreSQL partial unique index is the final concurrency
             * protection. Two simultaneous requests may both pass the
             * application-level existence check, but PostgreSQL still prevents
             * duplicate active sessions.
             */
            this.logger.error({
                message: "Failed to create MediaSession",
                roomId,
                err: error,
            });

            throw error;
        }
    }

    /**
     * Retrieves a MediaSession by its control-plane identity.
     */
    async getMediaSession(mediaSessionId: string): Promise<MediaSession> {
        const query = `
            SELECT
                id,
                room_id,
                status,
                assigned_sfu_node_id,
                created_at,
                started_at,
                ended_at
            FROM public.media_sessions
            WHERE id = $1`;

        const row = await this.pg.query<MediaSessionRow>(query, [
            mediaSessionId,
        ]);

        if (!row || row.rows.length < 1) {
            throw new NotFoundException(
                "The requested media session does not exist.",
            );
        }

        return mapMediaSessionRow(row.rows[0]);
    }

    async getMediaSessionByRoomId(roomId: string): Promise<MediaSession> {
        const query = `
            SELECT
                id,
                room_id,
                status,
                assigned_sfu_node_id,
                created_at,
                started_at,
                ended_at
            FROM public.media_sessions
            WHERE room_id = $1
            AND status IN (
                'CREATED',
                'STARTING',
                'ACTIVE',
                'ENDING'
            )
            ORDER BY created_at DESC
            LIMIT 1
        `;

        const row = await this.pg.query<MediaSessionRow>(query, [roomId]);

        if (!row || row.rows.length < 1) {
            throw new NotFoundException(
                "The requested watch room does not have an active media session.",
            );
        }

        return mapMediaSessionRow(row.rows[0]);
    }

    /**
     * Starts the control-plane MediaSession lifecycle.
     *
     * IMPORTANT:
     * This does not create the SFU runtime yet.
     *
     * MediaOrchestration will later be responsible for selecting an SFU node
     * and asking that node to create the corresponding runtime.
     */
    async startMediaSession(mediaSessionId: string): Promise<MediaSession> {
        const session = await this.getMediaSession(mediaSessionId);

        if (session.status !== "CREATED") {
            throw new ConflictException(
                `MediaSession cannot start from status ${session.status}.`,
            );
        }

        const query = `UPDATE public.media_sessions
            SET
                status = 'STARTING'
            WHERE id = $1
              AND status = 'CREATED'
            RETURNING
                id,
                room_id,
                status,
                assigned_sfu_node_id,
                created_at,
                started_at,
                ended_at`;

        const row = await this.pg.query<MediaSessionRow>(query, [
            mediaSessionId,
        ]);

        if (!row || row.rows.length < 1) {
            throw new ConflictException(
                "MediaSession state changed before it could be started.",
            );
        }

        this.logger.log({
            message: "MediaSession transitioned to STARTING",
            mediaSessionId,
        });

        return mapMediaSessionRow(row.rows[0]);
    }

    /**
     * Marks a MediaSession as ACTIVE.
     *
     * This operation is intentionally separated from startMediaSession().
     *
     * Later MediaOrchestration/SFU integration will call this only after the
     * assigned SFU runtime has been successfully established.
     */
    async activateMediaSession(mediaSessionId: string): Promise<MediaSession> {
        const query = `
            UPDATE public.media_sessions
            SET
                status = 'ACTIVE',
                started_at = COALESCE(started_at, NOW())
            WHERE id = $1
              AND status = 'STARTING'
            RETURNING
                id,
                room_id,
                status,
                assigned_sfu_node_id,
                created_at,
                started_at,
                ended_at
        `;

        const row = await this.pg.query<MediaSessionRow>(query, [
            mediaSessionId,
        ]);

        if (!row || row.rows.length < 1) {
            throw new ConflictException(
                "MediaSession cannot transition to ACTIVE from its current state.",
            );
        }

        this.logger.log({
            message: "MediaSession transitioned to ACTIVE",
            mediaSessionId,
        });

        return mapMediaSessionRow(row.rows[0]);
    }

    /**
     * Begins media-session shutdown.
     */
    async endMediaSession(mediaSessionId: string): Promise<MediaSession> {
        const session = await this.getMediaSession(mediaSessionId);

        if (
            session.status !== "CREATED" &&
            session.status !== "STARTING" &&
            session.status !== "ACTIVE"
        ) {
            throw new ConflictException(
                `MediaSession cannot end from status ${session.status}.`,
            );
        }

        const query = `
            UPDATE public.media_sessions
            SET
                status = 'ENDING'
            WHERE id = $1
              AND status IN (
                  'CREATED',
                  'STARTING',
                  'ACTIVE'
              )
            RETURNING
                id,
                room_id,
                status,
                assigned_sfu_node_id,
                created_at,
                started_at,
                ended_at
        `;

        const row = await this.pg.query<MediaSessionRow>(query, [
            mediaSessionId,
        ]);

        if (!row || row.rows.length < 1) {
            throw new ConflictException(
                "MediaSession state changed before it could be ended.",
            );
        }

        this.logger.log({
            message: "MediaSession transitioned to ENDING",
            mediaSessionId,
        });

        return mapMediaSessionRow(row.rows[0]);
    }

    /**
     * Permanently closes a MediaSession.
     *
     * This should happen after the media runtime has been successfully
     * terminated by the SFU layer.
     */
    async completeMediaSession(mediaSessionId: string): Promise<MediaSession> {
        const query = `
            UPDATE public.media_sessions
            SET
                status = 'ENDED',
                ended_at = NOW()
            WHERE id = $1
              AND status = 'ENDING'
            RETURNING
                id,
                room_id,
                status,
                assigned_sfu_node_id,
                created_at,
                started_at,
                ended_at
        `;

        const row = await this.pg.query<MediaSessionRow>(query, [
            mediaSessionId,
        ]);

        if (!row || row.rows.length < 1) {
            throw new ConflictException(
                "MediaSession cannot transition to ENDED from its current state.",
            );
        }

        this.logger.log({
            message: "MediaSession transitioned to ENDED",
            mediaSessionId,
        });

        return mapMediaSessionRow(row.rows[0]);
    }

    /**
     * Assigns a MediaSession to an SFU node.
     *
     * MediaOrchestration will eventually own the decision of which node
     * should receive the assignment.
     *
     * This method only persists the assignment.
     */
    async assignMediaSession(
        mediaSessionId: string,
        sfuNodeId: string,
    ): Promise<MediaSession> {
        const session = await this.getMediaSession(mediaSessionId);

        if (session.status !== "CREATED" && session.status !== "STARTING") {
            throw new ConflictException(
                `Cannot assign an SFU node while MediaSession is ${session.status}.`,
            );
        }

        const nodeQuery = `
            SELECT
                id,
                node_id,
                status
            FROM public.sfu_nodes
            WHERE node_id = $1
            LIMIT 1
        `;

        const node = await this.pg.query<{
            id: string;
            node_id: string;
            status: "HEALTHY" | "DEGRADED" | "UNAVAILABLE";
        }>(nodeQuery, [sfuNodeId]);

        if (!node || node.rows.length < 1) {
            throw new NotFoundException(
                `SFU node ${sfuNodeId} does not exist.`,
            );
        }

        if (
            node.rows[0].status !== "HEALTHY" &&
            node.rows[0].status !== "DEGRADED"
        ) {
            throw new ConflictException(
                `SFU node ${sfuNodeId} is not available.`,
            );
        }

        const updateQuery = `
            UPDATE public.media_sessions
            SET assigned_sfu_node_id = $1
            WHERE id = $2
            RETURNING
                id,
                room_id,
                status,
                assigned_sfu_node_id,
                created_at,
                started_at,
                ended_at
        `;

        const updatedSession = await this.pg.query<MediaSessionRow>(
            updateQuery,
            [node.rows[0].id, mediaSessionId],
        );

        if (!updatedSession || updatedSession.rows.length < 1) {
            throw new NotFoundException(
                `MediaSession ${mediaSessionId} was not found.`,
            );
        }

        this.logger.log({
            message: "SFU node assigned to MediaSession",
            mediaSessionId,
            sfuNodeId,
        });

        return mapMediaSessionRow(updatedSession.rows[0]);
    }
}
