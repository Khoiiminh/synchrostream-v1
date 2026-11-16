import type { PoolClient, QueryResult, QueryResultRow } from "pg";

/**
 * Anything a repository method can run SQL on: the pool (`PostgresProvider`)
 * or a transaction client handed out by `PostgresProvider.withTransaction`.
 * Declared structurally so `.query<Row>()` is callable on either; a union of
 * the two concrete types is not callable with a type argument.
 */
export interface SqlExecutor {
    query<T extends QueryResultRow = Record<string, unknown>>(
        text: string,
        params?: unknown[],
    ): Promise<QueryResult<T>>;
}

/** A client bound to an open transaction. */
export type TransactionClient = PoolClient;
