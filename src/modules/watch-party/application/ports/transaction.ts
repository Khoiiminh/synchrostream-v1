/**
 * An open transaction, opaque to the application layer. Use cases receive it
 * from `withTransaction` and hand it back to store methods; only the adapter
 * (the Postgres repository) knows it is a `pg` client.
 *
 * `undefined` where a port accepts it means "outside any transaction".
 */
export type Tx = object;
