import { Controller, Post, Body, HttpStatus, HttpCode, Logger } from "@nestjs/common";
import { PasswordService } from "./password-reset.service.js";
import { RequestResetDto, ResetPasswordDto } from "./password-reset.dto.js";

@Controller('password-reset')
export class PasswordController {
    private readonly logger = new Logger(PasswordController.name);

    constructor(private readonly passwordService: PasswordService) {}

    @Post('request')
    @HttpCode(HttpStatus.OK)
    async requestReset(@Body() dto: RequestResetDto) {
        this.logger.log(`POST /request received for ${dto.email}`);
        return this.passwordService.requestReset(dto);
    }

    @Post('confirm')
    @HttpCode(HttpStatus.OK)
    async resetPassword(@Body() dto: ResetPasswordDto) {
        this.logger.log(`POST /confirm received with token`);
        return this.passwordService.resetPassword(dto);
    }
}