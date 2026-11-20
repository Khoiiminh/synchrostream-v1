-- reset_expires timestamptz
--
-- users.reset_expires was `timestamp` without a time zone. node-pg sends a JS
-- Date as local time with an offset (e.g. 2026-11-20T19:00:00+07:00), and
-- Postgres drops the offset when casting to `timestamp`, so a reset token lived
-- 1 hour plus the API server's UTC offset (8 hours at UTC+7, already expired
-- west of UTC). As `timestamptz` the offset is honoured and `> NOW()` compares
-- real instants. No code change is needed.
--
-- Existing values are read as UTC, which is what a backend running at UTC
-- wrote. Reset tokens live an hour, so only tokens issued shortly before the
-- deploy can shift.
--
-- Compatibility: the running backend keeps working unchanged against the new
-- column (it only writes Date parameters and compares with NOW() in SQL).

-- Up Migration
ALTER TABLE public.users
    ALTER COLUMN reset_expires TYPE timestamptz
    USING reset_expires AT TIME ZONE 'UTC';

-- Down Migration
ALTER TABLE public.users
    ALTER COLUMN reset_expires TYPE timestamp
    USING reset_expires AT TIME ZONE 'UTC';
