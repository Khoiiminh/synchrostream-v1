import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { AuthService } from "./auth.service.js";
import { AuthRepository } from "./auth.repository.js";
import { AuthController } from "./auth.controller.js";
import { InfrastructureModule } from "src/shared/infrastructure/infrastructure.module.js";
import { JwtStrategy } from "./strategies/jwt.strategy.js";

@Module({
    imports: [
        InfrastructureModule,
        JwtModule.registerAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (config: ConfigService) => ({
                secret: config.get<string>("JWT_SECRET"),
                signOptions: { expiresIn: "1d" },
            }),
        }),
    ],
    providers: [AuthService, AuthRepository, JwtStrategy],
    controllers: [AuthController],
    exports: [AuthService, AuthRepository],
})
export class AuthModule {}
