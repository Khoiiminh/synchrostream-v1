# Database migrations

The files in this folder are the source of truth for the SynchroStream schema.
[node-pg-migrate](https://github.com/salsita/node-pg-migrate) applies them in order and records each one in the `public.pgmigrations` table.
The runner is `scripts/migrate.mjs`. It connects with the same `DATABASE_URL` and `DB_CA_CERT` as the backend.

The DbSchema files in `docs/DB_Schema` are diagrams and documentation only. Their exported SQL does not run as-is (DbSchema drops parentheses in CHECK constraints), so never apply them to a database.

## Commands

```bash
npm run migrate:status                    # applied and pending migrations
npm run migrate:create -- add_movie_tags  # new file: migrations/<UTC timestamp>_add_movie_tags.sql
npm run migrate:up                        # apply everything pending
npm run migrate:down -- --yes             # roll back the latest migration (local and dev only)
npm run migrate:baseline                  # only for adopting migrations on an existing database
```

The scripts load `.env.development` when it exists. On a server, set the variables in the environment instead.

## Writing a migration

```sql
-- Up Migration
ALTER TABLE public.movies ADD COLUMN duration_seconds integer;

-- Down Migration
ALTER TABLE public.movies DROP COLUMN duration_seconds;
```

- One logical change per file, written in plain SQL, the same way as the old manual upgrade notes.
- Pending migrations run in a single transaction. If one fails, the whole run is rolled back.
- Every connection sets `lock_timeout = 10s` (override it with `MIGRATE_LOCK_TIMEOUT`). A migration that can't get a lock fails instead of blocking live queries behind it. If that happens, run it again at a quieter time.
- Write a down section whenever the change can be reversed. Leave it out for changes that destroy data.

## Rules that keep this safe as the project grows

1. **Never edit a migration after it has run on a shared database.** Make a new one. The runner checks file order and refuses to run a file whose timestamp is older than the last applied migration. If a branch merge triggers that, rename the new file with `migrate:create` and move its SQL over.
2. **Run migrations before starting the new backend version.** Deploy order is `npm ci`, then `npm run migrate:up`, then start the app. The runner waits on an advisory lock, so two instances deploying at the same time can't run migrations twice.
3. **Keep each migration compatible with the backend that is already running.** During a deploy the old code still runs against the new schema. For breaking changes, use expand and contract:
   - *Expand:* add the new column, table or enum value (nullable or with a default), backfill it, then add the `NOT NULL` or CHECK constraint. This is how the v6 → v7 room lifecycle upgrade worked.
   - *Switch:* deploy code that reads and writes the new shape.
   - *Contract:* in a later migration, drop the old column once no deployed code uses it.
4. **Big tables need non-blocking DDL.** `CREATE INDEX CONCURRENTLY` cannot run in a transaction, so write that migration as a `.js` file:

   ```js
   export const up = (pgm) => {
       pgm.noTransaction();
       pgm.sql('CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_user ON public.chat_history (user_id)');
   };
   export const down = (pgm) => {
       pgm.noTransaction();
       pgm.sql('DROP INDEX CONCURRENTLY IF EXISTS public.idx_chat_user');
   };
   ```

   For large constraints, add them as `NOT VALID`, then run `VALIDATE CONSTRAINT` in a separate migration.
5. **Test before shared databases.** Run `migrate:up` against a scratch database first. An empty database gets built from the baseline plus every later migration, the same path CI and new environments take.

## Baseline

`20261115000000000_baseline_v8.sql` is the schema as of v8 (DbSchema v7 plus the UUIDv7 defaults).
It was checked on 2026-11-15: an empty database built from it matched the live Aiven database object for object (columns, defaults, constraints, indexes, enums, view, sequence ownership, extensions).
The live database was marked as already applied with `migrate:baseline`, so the file never runs there.
