import { maskEmail } from "../../common/logging/logger.js";
import {
    Injectable,
    BadRequestException,
    OnModuleInit,
    Logger,
    InternalServerErrorException,
} from "@nestjs/common";
import * as bcrypt from "bcrypt";
import * as crypto from "crypto";
import * as nodemailer from "nodemailer";
import { google } from "googleapis";
import { RequestResetDto, ResetPasswordDto } from "./password-reset.dto.js";
import { PasswordResetAccounts } from "../auth/queries/password-reset-accounts.js";
import { ACCOUNT_PASSWORD_HASH_COST } from "@/shared/auth/password-policy.js";
import {
    RESET_REQUEST_ANSWER,
    RESET_TOKEN_BYTES,
    resetLink,
    resetTokenExpiry,
    resetValidityText,
} from "./domain/reset-token.js";
import { ConfigService } from "@nestjs/config";
import {
    AttemptLimiter,
    PASSWORD_RESET_REQUEST_RULE,
} from "@/shared/infrastructure/cache/attempt-limiter.js";

@Injectable()
export class PasswordService implements OnModuleInit {
    private oauth2Client: InstanceType<typeof google.auth.OAuth2>;
    private clientId!: string;
    private clientSecret!: string;
    private redirectUrl!: string;
    private refreshToken!: string;

    // initialize logger
    private readonly logger = new Logger(PasswordService.name);

    constructor(
        private readonly configService: ConfigService,
        private readonly passwordResetRepository: PasswordResetAccounts,
        private readonly attemptLimiter: AttemptLimiter,
    ) {}

    onModuleInit() {
        this.clientId = this.configService.get<string>("GOOGLE_CLIENT_ID")!;
        this.clientSecret = this.configService.get<string>(
            "GOOGLE_CLIENT_SECRET",
        )!;
        this.redirectUrl = this.configService.get<string>(
            "GOOGLE_REDIRECT_URL",
        )!;
        this.refreshToken = this.configService.get<string>(
            "GOOGLE_REFRESH_TOKEN",
        )!;

        if (
            !this.clientId ||
            !this.clientSecret ||
            !this.redirectUrl ||
            !this.refreshToken
        ) {
            throw new Error(
                "[Internal] Critical Configuration Missing: Google OAuth2 credentials are required for the PasswordService.",
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
            service: "gmail",
            auth: {
                type: "OAuth2",
                user: this.configService.get<string>("MAIL_USER"),
                clientId: this.clientId,
                clientSecret: this.clientSecret,
                refreshToken: this.refreshToken,
                accessToken: token ?? undefined,
            },
        });
    }

    async requestReset(dto: RequestResetDto) {
        this.logger.log({
            message: "Password reset requested",
            email: maskEmail(dto.email),
        });

        // Every request counts, known email or not, so the limit itself
        // reveals nothing about which accounts exist.
        await this.attemptLimiter.consume(
            PASSWORD_RESET_REQUEST_RULE,
            AttemptLimiter.emailId(dto.email),
        );

        const userId = await this.passwordResetRepository.findUserIdByEmail(
            dto.email,
        );

        if (!userId) {
            // Log as warn, but won't throw to prevent email enumeration attacks
            this.logger.warn({
                message: "Password reset requested for unknown email",
                email: maskEmail(dto.email),
            });
            return { ...RESET_REQUEST_ANSWER };
        }

        const token = crypto.randomBytes(RESET_TOKEN_BYTES).toString("hex");
        const expiresAt = resetTokenExpiry(Date.now());

        this.logger.debug({
            message: "Generated password reset token",
            userId,
        });

        await this.passwordResetRepository.saveResetToken(
            userId,
            token,
            expiresAt,
        );

        try {
            const payload = { email: dto.email, token: token };

            await this.sendResetEmail(payload);

            this.logger.log({
                message: "Password reset email sent",
                email: maskEmail(dto.email),
            });
        } catch (error) {
            const errorMessage =
                error instanceof Error ? error.message : String(error);
            this.logger.error({
                message: "Failed to send password reset email",
                error: errorMessage,
            });
            throw new InternalServerErrorException("Error sending email");
        }

        return { ...RESET_REQUEST_ANSWER };
    }

    private async sendResetEmail({
        email,
        token,
    }: {
        email: string;
        token: string;
    }) {
        const frontendUrl = this.configService.get<string>("FRONTEND_URL");
        const transporter = await this.createTransporter();

        const html = `
            <div style="font-family: sans-serif; text-align: center; border: 1px solid #eee; padding: 20px;">
                <h2 style="color: #333;">SynchroStream</h2>
                <p>You requested a password reset. This verification is valid for ${resetValidityText()}.</p>
                <a href="${resetLink(frontendUrl, token)}" 
                   style="display: inline-block; background: #000; color: #fff; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">
                   Reset Password
                </a>
            </div>
        `;

        await transporter.sendMail({
            from: `"SynchroStream Support" <${this.configService.get<string>("MAIL_USER")}>`,
            to: email,
            subject: "Password Reset Request",
            html: html,
        });
    }

    async resetPassword(dto: ResetPasswordDto) {
        this.logger.debug({ message: "Password reset attempt" });

        const userId =
            await this.passwordResetRepository.findUserIdByResetToken(
                dto.token,
            );

        if (!userId) {
            this.logger.warn({
                message: "Password reset rejected: token invalid or expired",
            });
            throw new BadRequestException("Invalid or expired token");
        }

        const newHash = await bcrypt.hash(
            dto.newPassword,
            ACCOUNT_PASSWORD_HASH_COST,
        );

        await this.passwordResetRepository.updatePasswordAndClearToken(
            userId,
            newHash,
        );
        this.logger.log({ message: "Password updated", userId });

        return {
            message: "Password updated successfully",
            userId,
        };
    }
}
