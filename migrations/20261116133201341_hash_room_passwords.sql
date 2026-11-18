-- hash room passwords
--
-- Room passwords used to be stored in plaintext. The backend now writes bcrypt
-- hashes and checks joins with bcrypt.compare, so hash every row that is not
-- already a bcrypt hash. pgcrypto's crypt()/gen_salt('bf') emits $2a$ hashes,
-- which the node bcrypt library verifies. Cost 10 matches the backend.
--
-- Compatibility: a backend from before this change compares plaintext, so while
-- it is still running after this migration, joins to existing password rooms
-- fail. Rooms are short-lived; deploy migrate:up and the new backend together.
--
-- No down migration: the plaintext cannot be recovered from the hashes.

-- Up Migration
UPDATE public.rooms
SET "password" = public.crypt("password", public.gen_salt('bf', 10))
WHERE "password" !~ '^\$2[aby]\$[0-9]{2}\$.{53}$';
