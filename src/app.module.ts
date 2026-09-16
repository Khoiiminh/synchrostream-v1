import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './modules/auth/auth.module.js';
import { PasswordResetModule } from './modules/password-reset/password-reset.module.js';
import { InfrastructureModule } from './shared/infrastructure/infrastructure.module.js';
import { AdminModule } from './modules/admin/admin.module.js';
import { MediaModule } from './modules/media/media.module.js';
import { WatchPartyModule } from './modules/watch-party/watch-party.module.js';
import { MediaSessionModule } from './modules/media-session/media-session.module.js';

@Module({
    imports: [
        ConfigModule.forRoot({
            envFilePath: '.env.development',
            isGlobal: true
        }),
        InfrastructureModule,
        AuthModule,
        PasswordResetModule,
        AdminModule,
        MediaModule,
        WatchPartyModule,

        MediaSessionModule,
    ],
    controllers: [AppController],
    providers: [AppService],
})
export class AppModule {}