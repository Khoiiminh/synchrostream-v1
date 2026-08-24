import { Injectable, NotFoundException, BadRequestException, OnModuleInit, Logger, InternalServerErrorException } from "@nestjs/common";
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import * as nodemailer from 'nodemailer';
import { google } from 'googleapis';
import { PostgresProvider } from "src/shared/infrastructure/database/postgres.provider.js";
import { RequestResetDto, ResetPasswordDto } from "./password-reset.dto.js";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class PasswordService implements OnModuleInit {
    private oauth2Client: any;
    private clientId!: string;
    private clientSecret!: string;
    private redirectUrl!: string;
    private refreshToken!: string;
    private tokenTTL!: number;

    // initialize logger
    private readonly logger = new Logger(PasswordService.name);

    constructor(
        private readonly configService: ConfigService, 
        private readonly pg: PostgresProvider
    ) {}

    onModuleInit() {
        this.clientId = this.configService.get<string>('GOOGLE_CLIENT_ID')!;
        this.clientSecret = this.configService.get<string>('GOOGLE_CLIENT_SECRET')!;
        this.redirectUrl = this.configService.get<string>('GOOGLE_REDIRECT_URL')!;
        this.refreshToken = this.configService.get<string>('GOOGLE_REFRESH_TOKEN')!;

        if (!this.clientId || !this.clientSecret || !this.redirectUrl || !this.refreshToken) {
            throw new Error(
                '[Internal] Critical Configuration Missing: Google OAuth2 credentials are required for the PasswordService.'
            );
        }

        this.oauth2Client = new google.auth.OAuth2({
            clientId: this.clientId,
            clientSecret: this.clientSecret,
            redirectUri: this.redirectUrl,
        });

        this.oauth2Client.setCredentials({
            refresh_token: this.refreshToken,
        });
    }

    private async createTransporter(): Promise<nodemailer.Transporter> {
        const { token } = await this.oauth2Client.getAccessToken();

        return nodemailer.createTransport({
            service: 'gmail',
            auth: {
                type: 'OAuth2',
                user: this.configService.get<string>('MAIL_USER'),
                clientId: this.clientId,
                clientSecret: this.clientSecret,
                refreshToken: this.refreshToken,
                accessToken: token as string,
            },
        } as any);
    }

    async requestReset(dto: RequestResetDto) {
        this.logger.log(`Password reset request for email: ${dto.email}`);

        const [user] = await this.pg.query<any>(
            'SELECT id FROM users WHERE email = $1',
            [dto.email]
        );

        if (!user) {
            // Log as warn, but won't throw to prevent email enumeration attacks
            this.logger.warn(`Reset requested for non-existent email: ${dto.email}`);
            return {
                message: 'If an account exists, a reset link has been sent.'
            }
        };

        const ttl = 3600000;

        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + ttl);

        this.tokenTTL = ttl;

        this.logger.debug(`Generate reset token for user ID: ${user.id}`);

        await this.pg.query(
            'UPDATE users SET reset_token = $1, reset_expires = $2 WHERE id = $3',
            [token, expiresAt, user.id]
        );

        try {
            const payload = { email: dto.email, token: token };

            await this.sendResetEmail(payload);

            this.logger.log(`Reset email successfully dispatched to: ${dto.email}`);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logger.error(`SMTP/OAuth2 Error: ${errorMessage}`);
            throw new InternalServerErrorException('Error sending email');
        }


        return { message: 'If an account exists, a reset link has been sent.'};
    }

    private async sendResetEmail({ email, token }: { email: string, token: string }){
        const frontendUrl = this.configService.get<string>('FRONTEND_URL');
        const transporter = await this.createTransporter();
        const ttl = ((this.tokenTTL / 1000) / 60);

        const html = `
            <div style="font-family: sans-serif; text-align: center; border: 1px solid #eee; padding: 20px;">
                <h2 style="color: #333;">SynchroStream</h2>
                <p>You requested a password reset. This verification is valid for ${ttl} ${ttl > 1 ? "minutes" : "minute"}.</p>
                <a href="${frontendUrl}/auth/password-reset?token=${token}" 
                   style="display: inline-block; background: #000; color: #fff; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">
                   Reset Password
                </a>
            </div>
        `;

        await transporter.sendMail({
            from: `"SynchroStream Support" <${this.configService.get<string>('MAIL_USER')}>`,
            to: email,
            subject: 'Password Reset Request',
            html: html,
        });
    }

    async resetPassword(dto: ResetPasswordDto) {
        this.logger.log(`Attempting password reset with token: ${dto.token.substring(0, 10)}...`);

        const [user] = await this.pg.query<any>(
            'SELECT id FROM users WHERE reset_token = $1',
            [dto.token]
        );

        if (!user) {
            this.logger.error(`Reset failed: Token is invalid or has expired`);
            throw new BadRequestException('Invalid or expired token')
        };

        const newHash = await bcrypt.hash(dto.newPassword, 10);

        await this.pg.withTransaction(async (client) => {
            await client.query('UPDATE users SET password_hash = $1 where id = $2', [newHash, user.id]);
            await client.query('UPDATE users SET reset_token = NULL, reset_expires = NULL where id = $1', [user.id]);
            this.logger.log(`Password updated and tokens cleared for user: ${user.id}`);
        });

        return { 
            message: 'Password updated successfully',
            userId: user.id, 
        };
    }
}