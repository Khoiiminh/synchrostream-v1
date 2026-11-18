-- Baseline: the SynchroStream schema as of v8 (docs/DB_Schema v7 + the UUIDv7 defaults upgrade).
--
-- Existing databases already have this schema and were marked as applied with
-- `npm run migrate:baseline`, so this file only runs on empty databases
-- (new environments, CI, local scratch databases).
--
-- Never edit this file. Change the schema with a new migration.

-- Up Migration

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

-- Enum types ---------------------------------------------------------------

CREATE TYPE public.media_session_status AS ENUM ('CREATED', 'STARTING', 'ACTIVE', 'ENDING', 'ENDED');
CREATE TYPE public.processing_status AS ENUM ('PROCESSING', 'AVAILABLE', 'FAILED');
CREATE TYPE public.room_lifecycle_status AS ENUM ('PROVISIONING', 'ACTIVE', 'TERMINATING', 'TERMINATED');
CREATE TYPE public.sfu_node_status AS ENUM ('HEALTHY', 'DEGRADED', 'UNAVAILABLE');
CREATE TYPE public.user_role AS ENUM ('ADMIN', 'USER');

-- users --------------------------------------------------------------------

CREATE TABLE public.users (
    id            uuid DEFAULT uuidv7() NOT NULL,
    username      varchar(50) NOT NULL,
    email         varchar(100) NOT NULL,
    password_hash text NOT NULL,
    "role"        public.user_role DEFAULT 'USER'::public.user_role,
    created_at    timestamptz DEFAULT CURRENT_TIMESTAMP,
    reset_token   varchar(255) DEFAULT NULL::character varying,
    reset_expires timestamp,
    CONSTRAINT users_pkey PRIMARY KEY (id),
    CONSTRAINT users_username_key UNIQUE (username),
    CONSTRAINT users_email_key UNIQUE (email)
);

-- movies -------------------------------------------------------------------

CREATE TABLE public.movies (
    id            uuid DEFAULT uuidv7() NOT NULL,
    title         varchar(255) NOT NULL,
    hls_url       text,
    dash_url      text,
    status        public.processing_status DEFAULT 'PROCESSING'::public.processing_status,
    is_cmaf_ready boolean DEFAULT false,
    metadata      jsonb DEFAULT '{}'::jsonb,
    created_at    timestamptz DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT movies_pkey PRIMARY KEY (id)
);

-- sfu_nodes ----------------------------------------------------------------

CREATE TABLE public.sfu_nodes (
    id                 uuid DEFAULT uuidv7() NOT NULL,
    endpoint           text NOT NULL,
    status             public.sfu_node_status DEFAULT 'HEALTHY'::public.sfu_node_status,
    capacity           integer NOT NULL,
    last_heartbeat_at  timestamptz,
    created_at         timestamptz DEFAULT CURRENT_TIMESTAMP,
    node_id            varchar(100) NOT NULL,
    signaling_endpoint text NOT NULL,
    CONSTRAINT sfu_nodes_pkey PRIMARY KEY (id),
    CONSTRAINT sfu_nodes_node_id_key UNIQUE (node_id),
    CONSTRAINT sfu_nodes_capacity_check CHECK (capacity > 0)
);

-- rooms --------------------------------------------------------------------

CREATE TABLE public.rooms (
    id               uuid DEFAULT uuidv7() NOT NULL,
    room_code        varchar(6) NOT NULL,
    "password"       text NOT NULL,
    owner_id         uuid,
    movie_id         uuid,
    max_participants integer DEFAULT 5,
    is_active        boolean DEFAULT false NOT NULL,
    created_at       timestamptz DEFAULT CURRENT_TIMESTAMP,
    lifecycle_status public.room_lifecycle_status DEFAULT 'PROVISIONING'::public.room_lifecycle_status NOT NULL,
    state_version    bigint DEFAULT 1 NOT NULL,
    CONSTRAINT rooms_pkey PRIMARY KEY (id),
    CONSTRAINT rooms_lifecycle_active_consistency
        CHECK (is_active = (lifecycle_status = 'ACTIVE'::public.room_lifecycle_status)),
    CONSTRAINT rooms_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users (id) ON DELETE CASCADE,
    CONSTRAINT rooms_movie_id_fkey FOREIGN KEY (movie_id) REFERENCES public.movies (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_active_room_code ON public.rooms USING btree (room_code)
    WHERE (lifecycle_status = ANY (ARRAY[
        'PROVISIONING'::public.room_lifecycle_status,
        'ACTIVE'::public.room_lifecycle_status,
        'TERMINATING'::public.room_lifecycle_status
    ]));

-- room_participants --------------------------------------------------------

CREATE TABLE public.room_participants (
    id                    uuid DEFAULT uuidv7() NOT NULL,
    room_id               uuid,
    user_id               uuid,
    rtc_identity          text,
    has_control_privilege boolean DEFAULT false,
    joined_at             timestamptz DEFAULT CURRENT_TIMESTAMP,
    is_active             boolean DEFAULT true NOT NULL,
    left_at               timestamptz,
    CONSTRAINT room_participants_pkey PRIMARY KEY (id),
    CONSTRAINT room_participants_rtc_identity_key UNIQUE (rtc_identity),
    CONSTRAINT room_participants_active_user_required CHECK ((NOT is_active) OR (user_id IS NOT NULL)),
    CONSTRAINT room_participants_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms (id) ON DELETE CASCADE,
    CONSTRAINT room_participants_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users (id) ON DELETE SET NULL
);

CREATE INDEX idx_participant_room ON public.room_participants USING btree (room_id);
CREATE UNIQUE INDEX idx_one_active_room_per_user ON public.room_participants USING btree (user_id)
    WHERE (is_active = true);

-- chat_history -------------------------------------------------------------

CREATE SEQUENCE public.chat_history_id_seq START WITH 1 INCREMENT BY 1;

CREATE TABLE public.chat_history (
    id                  bigint DEFAULT nextval('public.chat_history_id_seq'::regclass) NOT NULL,
    room_id             uuid,
    user_id             uuid,
    sender_name_at_time varchar(50),
    message             text NOT NULL,
    sent_at             timestamptz DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chat_history_pkey PRIMARY KEY (id),
    CONSTRAINT chat_history_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms (id) ON DELETE CASCADE,
    CONSTRAINT chat_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users (id) ON DELETE SET NULL
);

ALTER SEQUENCE public.chat_history_id_seq OWNED BY public.chat_history.id;

CREATE INDEX idx_chat_room_time ON public.chat_history USING btree (room_id, sent_at DESC);

-- media_sessions -----------------------------------------------------------

CREATE TABLE public.media_sessions (
    id                   uuid DEFAULT uuidv7() NOT NULL,
    room_id              uuid NOT NULL,
    status               public.media_session_status DEFAULT 'CREATED'::public.media_session_status,
    assigned_sfu_node_id uuid,
    created_at           timestamptz DEFAULT CURRENT_TIMESTAMP,
    started_at           timestamptz,
    ended_at             timestamptz,
    CONSTRAINT media_sessions_pkey PRIMARY KEY (id),
    CONSTRAINT media_sessions_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms (id) ON DELETE CASCADE,
    CONSTRAINT media_sessions_sfu_node_id_fkey FOREIGN KEY (assigned_sfu_node_id) REFERENCES public.sfu_nodes (id) ON DELETE SET NULL
);

CREATE INDEX idx_media_sessions_room ON public.media_sessions USING btree (room_id);
CREATE INDEX idx_media_sessions_sfu_node ON public.media_sessions USING btree (assigned_sfu_node_id);
CREATE UNIQUE INDEX idx_active_media_session_room ON public.media_sessions USING btree (room_id)
    WHERE (status = ANY (ARRAY[
        'CREATED'::public.media_session_status,
        'STARTING'::public.media_session_status,
        'ACTIVE'::public.media_session_status,
        'ENDING'::public.media_session_status
    ]));

-- room_lifecycle_outbox ----------------------------------------------------

CREATE TABLE public.room_lifecycle_outbox (
    event_id        uuid DEFAULT uuidv7() NOT NULL,
    event_type      text NOT NULL,
    aggregate_id    uuid NOT NULL,
    status          text DEFAULT 'PENDING'::text NOT NULL,
    attempts        integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamptz DEFAULT now() NOT NULL,
    locked_by       text,
    locked_until    timestamptz,
    last_error      text,
    created_at      timestamptz DEFAULT now() NOT NULL,
    completed_at    timestamptz,
    CONSTRAINT room_lifecycle_outbox_pkey PRIMARY KEY (event_id),
    CONSTRAINT room_lifecycle_outbox_attempts_check CHECK (attempts >= 0),
    CONSTRAINT room_lifecycle_outbox_lease_consistency
        CHECK ((status = 'PROCESSING'::text) = ((locked_by IS NOT NULL) AND (locked_until IS NOT NULL))),
    CONSTRAINT room_lifecycle_outbox_completion_consistency
        CHECK ((status = 'COMPLETED'::text) = (completed_at IS NOT NULL)),
    CONSTRAINT room_lifecycle_outbox_status_check
        CHECK (status = ANY (ARRAY['PENDING'::text, 'PROCESSING'::text, 'COMPLETED'::text, 'DEAD'::text])),
    CONSTRAINT room_lifecycle_outbox_event_type_check
        CHECK (event_type = ANY (ARRAY['ROOM_RECONCILE'::text, 'LIVEKIT_SESSION_RECONCILE'::text]))
);

CREATE INDEX idx_room_lifecycle_outbox_pending ON public.room_lifecycle_outbox USING btree (next_attempt_at, created_at)
    WHERE (status = ANY (ARRAY['PENDING'::text, 'PROCESSING'::text]));
CREATE INDEX idx_room_lifecycle_outbox_aggregate ON public.room_lifecycle_outbox USING btree (aggregate_id, created_at);

-- Views --------------------------------------------------------------------

CREATE VIEW public.engagement_analytics AS
SELECT r.id AS room_id,
       m.title AS movie_title,
       p.user_id,
       p.joined_at,
       (EXTRACT(epoch FROM (now() - p.joined_at)) / (60)::numeric) AS minutes_engaged
FROM public.room_participants p
JOIN public.rooms r ON p.room_id = r.id
JOIN public.movies m ON r.movie_id = m.id
WHERE r.is_active = true;

-- No Down Migration: the baseline cannot be rolled back.
