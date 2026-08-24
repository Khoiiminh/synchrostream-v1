import { Module } from "@nestjs/common";
import { PasswordController } from "./password-reset.controller.js";
import { PasswordService } from "./password-reset.service.js";
import { InfrastructureModule } from "src/shared/infrastructure/infrastructure.module.js";

@Module({
    imports: [InfrastructureModule],
    controllers: [PasswordController],
    providers: [PasswordService],
})
export class PasswordResetModule {}