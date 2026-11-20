import { Module } from "@nestjs/common";
import { PasswordController } from "./password-reset.controller.js";
import { PasswordService } from "./password-reset.service.js";
import { InfrastructureModule } from "src/shared/infrastructure/infrastructure.module.js";
import { AuthModule } from "../auth/auth.module.js";

@Module({
    imports: [InfrastructureModule, AuthModule],
    controllers: [PasswordController],
    providers: [PasswordService],
})
export class PasswordResetModule {}
