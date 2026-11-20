import { Module } from "@nestjs/common";
import { AppController } from "./app.controller.js";
import { AppService } from "./app.service.js";
import { ConfigModule } from "@nestjs/config";
import { ENV_FILE_PATH } from "./common/config/load-env.js";
import { AuthModule } from "./modules/auth/auth.module.js";
import { PasswordResetModule } from "./modules/password-reset/password-reset.module.js";
import { InfrastructureModule } from "./shared/infrastructure/infrastructure.module.js";
import { AdminModule } from "./modules/admin/admin.module.js";
import { MediaModule } from "./modules/media/media.module.js";
import { WatchPartyModule } from "./modules/watch-party/watch-party.module.js";
import { LiveKitApplicationModule } from "./modules/livekit/livekit.module.js";
import { SyncMetricsModule } from "./modules/sync-metrics/sync-metrics.module.js";

@Module({
    imports: [
        ConfigModule.forRoot({
            envFilePath: ENV_FILE_PATH,
            isGlobal: true,
        }),
        InfrastructureModule,
        AuthModule,
        PasswordResetModule,
        AdminModule,
        MediaModule,
        WatchPartyModule,

        LiveKitApplicationModule,
        SyncMetricsModule,
    ],
    controllers: [AppController],
    providers: [AppService],
})
export class AppModule {}
