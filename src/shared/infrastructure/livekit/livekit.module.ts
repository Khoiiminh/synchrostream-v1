import { Module } from "@nestjs/common";
import { LIVEKIT_CONFIG, LiveKitConfig } from "./livekit.types.js";
import { ConfigService } from "@nestjs/config";
import { LiveKitInfrastructureService } from "./livekit.infrastructure.service.js";
import { LiveKitTokenService } from "./livekit.token.service.js";

@Module({
    providers: [
        {
            provide: LIVEKIT_CONFIG,
            inject: [
                ConfigService
            ],
            useFactory: (configService: ConfigService): LiveKitConfig => {
                const url = configService.get<string>('LIVEKIT_URL');
                const apiKey = configService.get<string>('LIVEKIT_API_KEY');
                const apiSecret = configService.get<string>('LIVEKIT_API_SECRET');

                if (!url) {
                    throw new Error("LIVEKIT_URL is not configured.");
                }

                if (!apiKey) {
                    throw new Error("LIVEKIT_API_KEY is not configured.");
                }

                if (!apiSecret) {
                    throw new Error("LIVEKIT_API_SECRET is not configured.");
                }

                return {
                    url,
                    apiKey,
                    apiSecret,
                };
            },
        },
        LiveKitInfrastructureService,
        LiveKitTokenService,
    ],
    exports: [
        LiveKitInfrastructureService,
        LiveKitTokenService,
        LIVEKIT_CONFIG,
    ],
})
export class LiveKitModule {}