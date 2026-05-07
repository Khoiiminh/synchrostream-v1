import { Pool, PoolClient } from 'pg';
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class PostgresProvider implements OnModuleInit, OnModuleDestroy {
    private pool!: Pool;
    private caContent: string = fs.readFileSync(path.join(process.cwd(), 'certs/ca.pem')).toString();

    constructor(private configServie: ConfigService) {}

    onModuleInit() {
        const connectionString = this.configServie.get<string>('DATABASE_URL');

        if (!connectionString) {
            throw new Error('DATABASE_URL is not defined in .env.development');
        }

        this.pool = new Pool({
            connectionString,
            max: 20,
            idleTimeoutMillis: 30000,
            ssl: { 
                rejectUnauthorized: true,
                ca: [this.caContent] 
            }
        });

        console.log('PostgreSQL Connection Pool initialized');
    }

    /**
     * Executes a Plain SQL query using Parameterized Queries to prevent Injection[cite: 1, 4].
     */
    async query<T>(text: string, params?: any[]): Promise<T[]> {
        const res = await this.pool.query(text, params);
        return res.rows as T[];
    }

    /**
     * Executes a series of operations within a single SQL Transaction.
     * Critical for Room Creation logic involving multiple tables[cite: 2].
     */
    async withTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        try {

            await client.query('BEGIN');
            const result = await callback(client);
            await client.query('COMMIT');
            return result;
            
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    async onModuleDestroy() {
        await this.pool.end();
        console.log('PostgreSQL Pool closed');
    }
}
