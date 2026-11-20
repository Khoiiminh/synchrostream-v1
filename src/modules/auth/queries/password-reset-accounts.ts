import { Injectable } from "@nestjs/common";
import { PostgresProvider } from "@/shared/infrastructure/database/postgres.provider.js";

/**
 * Auth's published contract for the password-reset flow: the reset-token
 * columns and password updates on `users`, which auth owns.
 *
 * SQL moved byte-for-byte from password-reset/password-reset.repository.ts
 * (plan B4).
 */
@Injectable()
export class PasswordResetAccounts {
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

    /** Matches only tokens that have not yet passed `reset_expires`. */
    async findUserIdByResetToken(token: string): Promise<string | undefined> {
        const result = await this.pg.query<{ id: string }>(
            "SELECT id FROM users WHERE reset_token = $1 AND reset_expires > NOW()",
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
