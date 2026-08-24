import { Controller, Post, Body, HttpStatus, HttpCode, Logger } from "@nestjs/common";
import { PasswordService } from "./password-reset.service.js";
import { RequestResetDto, ResetPasswordDto } from "./password-reset.dto.js";
import { RedisProvider } from "@/shared/infrastructure/cache/redis.provider.js";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";

@ApiTags('Password Recovery Engine')
@Controller('auth/password-reset')
export class PasswordController {
    private readonly logger = new Logger(PasswordController.name);

    constructor(
        private readonly passwordService: PasswordService,
        private readonly redis: RedisProvider,
    ) {}

    @Post('request')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Initiate password reset',
        description: 'Sends a secure reset link to the provided email address if the account exists'
    })
    @ApiResponse({
        status: 200,
        description: 'Request processed. For security, the response is the same whether the email exists or not.',
        schema: {
            example: {
                success: true,
                message: 'If an account exists, a reset link has been sent.',
                data: null,
                timestamp: '2026-06-01T13:00:00.000Z'
            }
        }
    })
    @ApiResponse({
        status: 500,
        description: 'Internal Server Error: Likely a failure in the Mailer or Database connection.',
        schema: {
            example: {
                success: false,
                message: 'Error sending email',
                data: 'Internal Server Error',
                timestamp: '2026-06-01T13:02:00.000Z'
            }
        }
    })
    async requestReset(@Body() dto: RequestResetDto) {
        this.logger.log(`POST /request received for ${dto.email}`);
        return this.passwordService.requestReset(dto);
    }

    @Post('confirm')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Confirm password reset',
        description: 'Validates the reset token, updates the password, and invalidates all existing sessions (Global Logout).'
    })
    @ApiResponse({
        status: 200,
        description: 'Password successfully updated and sessions revoked.',
        schema: {
            example: {
                success: true,
                message: 'Password has been reset successfully',
                data: null,
                timestamp: '2026-06-01T13:05:00.000Z'
            }
        }
    })
    @ApiResponse({
        status: 400,
        description: 'Bad Request: Invalid or expired token.',
        schema: {
            example: {
                success: false,
                message: 'Invalid or expired token',
                data: 'Bad Request',
                timestamp: '2026-06-01T13:06:00.000Z'
            }
        }
    })
    async resetPassword(@Body() dto: ResetPasswordDto) {
        this.logger.log(`Confirming password reset for token ending in ...${dto.token.slice(-5)}`);
        const result = await this.passwordService.resetPassword(dto);

        if (result.userId) {
            await this.redis['client'].del(`user:${result.userId}:session`);
            this.logger.log(`Active session invalidated for user: ${result.userId} due to password reset`);
        }

        return { message: result.message };
    }
}