import { Injectable } from "@nestjs/common";
import { PostgresProvider } from "@/shared/infrastructure/database/postgres.provider.js";
import type { UserCredentialsRow, UserProfileRow } from "./auth.types.js";

/** All SQL touching the `users` table for authentication. */
@Injectable()
export class AuthRepository {
    constructor(private readonly pg: PostgresProvider) {}

    async existsByEmailOrUsername(
        email: string,
        username: string,
    ): Promise<boolean> {
        const result = await this.pg.query(
            "SELECT id FROM users WHERE email = $1 OR username = $2",
            [email, username],
        );
        return result.rows.length > 0;
    }

    async createUser(
        username: string,
        email: string,
        passwordHash: string,
    ): Promise<string> {
        const result = await this.pg.query<{ id: string }>(
            "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id",
            [username, email, passwordHash],
        );
        return result.rows[0].id;
    }

    async findCredentialsByEmail(
        email: string,
    ): Promise<UserCredentialsRow | undefined> {
        const result = await this.pg.query<UserCredentialsRow>(
            "SELECT id, username, email, password_hash, role FROM users WHERE email = $1",
            [email],
        );
        return result.rows[0];
    }

    async findProfileById(userId: string): Promise<UserProfileRow | undefined> {
        const result = await this.pg.query<UserProfileRow>(
            "SELECT id, username, email, role FROM public.users WHERE id = $1",
            [userId],
        );
        return result.rows[0];
    }
}
