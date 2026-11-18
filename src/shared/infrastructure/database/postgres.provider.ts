import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import {
    Injectable,
    Logger,
    OnModuleInit,
    OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class PostgresProvider implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(PostgresProvider.name);
    private pool!: Pool;

    constructor(private configService: ConfigService) {}

    onModuleInit() {
        const connectionString = this.configService.get<string>("DATABASE_URL");
        const caContent = this.configService.get<string>("DB_CA_CERT");

        if (!connectionString) {
            throw new Error("DATABASE_URL is not defined in .env.development");
        }

        this.pool = new Pool({
            connectionString,
            max: 20,
            idleTimeoutMillis: 30000,
            ssl: caContent
                ? { rejectUnauthorized: true, ca: [caContent] }
                : undefined,
        });

        this.logger.log({ message: "PostgreSQL pool initialized" });
    }

    /**
     * Executes a parameterized SQL query. Pass the row shape as `T`; untyped
     * calls get `Record<string, unknown>` rows, so columns must be narrowed before use.
     */
    async query<T extends QueryResultRow = Record<string, unknown>>(
        text: string,
        params?: unknown[],
    ): Promise<QueryResult<T>> {
        return this.pool.query<T>(text, params);
    }

    /**
     * Executes a series of operations within a single SQL Transaction.
     * Critical for Room Creation logic involving multiple tables[cite: 2].
     */
    async withTransaction<T>(
        callback: (client: PoolClient) => Promise<T>,
    ): Promise<T> {
        const client = await this.pool.connect();
        let transactionStarted = false;
        // A client whose ROLLBACK failed is in an unknown state; destroy it
        // instead of returning it to the pool.
        let releaseError: Error | undefined;
        try {
            await client.query("BEGIN");
            transactionStarted = true;
            const result = await callback(client);
            await client.query("COMMIT");
            transactionStarted = false;
            return result;
        } catch (error) {
            if (transactionStarted) {
                try {
                    await client.query("ROLLBACK");
                } catch (rollbackError) {
                    releaseError =
                        rollbackError instanceof Error
                            ? rollbackError
                            : new Error(String(rollbackError));
                    this.logger.error({
                        message:
                            "PostgreSQL transaction rollback failed; preserving the original error",
                        err: error,
                        rollbackError,
                    });
                }
            }
            throw error;
        } finally {
            client.release(releaseError);
        }
    }

    async onModuleDestroy() {
        await this.pool.end();
        this.logger.log({ message: "PostgreSQL pool closed" });
    }
}
