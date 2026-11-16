import { Injectable } from "@nestjs/common";
import { PostgresProvider } from "@/shared/infrastructure/database/postgres.provider.js";

/** All SQL for password-reset tokens and password updates. */
@Injectable()
export class PasswordResetRepository {
    constructor(private readonly pg: PostgresProvider) {}

    async findUserIdByEmail(email: string): Promise<string | undefined> {
        const result = await this.pg.query<{ id: string }>(
            "SELECT id FROM users WHERE email = $1",
            [email],
        );
        return result.rows[0]?.id;
    }

    async saveResetToken(
        userId: string,
        token: string,
        expiresAt: Date,
    ): Promise<void> {
        await this.pg.query(
            "UPDATE users SET reset_token = $1, reset_expires = $2 WHERE id = $3",
            [token, expiresAt, userId],
        );
    }

    async findUserIdByResetToken(token: string): Promise<string | undefined> {
        const result = await this.pg.query<{ id: string }>(
            "SELECT id FROM users WHERE reset_token = $1",
            [token],
        );
        return result.rows[0]?.id;
    }

    /** Sets the new hash and clears the reset token in one transaction. */
    async updatePasswordAndClearToken(
        userId: string,
        passwordHash: string,
    ): Promise<void> {
        await this.pg.withTransaction(async (client) => {
            await client.query(
                "UPDATE users SET password_hash = $1 where id = $2",
                [passwordHash, userId],
            );
            await client.query(
                "UPDATE users SET reset_token = NULL, reset_expires = NULL where id = $1",
                [userId],
            );
        });
    }
}
