import type { Client } from "pg";

export declare const DEFAULT_ADMIN_URL: string;
export declare const TEST_DATABASE_NAME: string;
export declare const TEST_DATABASE_URL_ENV: string;
export declare function assertLocal(connectionString: string): void;
export declare function adminUrl(): string;
export declare function databaseUrl(admin: string, database: string): string;
export declare function withAdminClient<T>(
    fn: (client: Client) => Promise<T>,
): Promise<T>;
export declare function dropDatabase(client: Client, name: string): Promise<void>;
