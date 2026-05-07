import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './modules/auth/auth.module.js';
import { PasswordResetModule } from './modules/password-reset/password-reset.module.js';

@Module({
    imports: [
        ConfigModule.forRoot({
            envFilePath: '.env.development',
            isGlobal: true
        }),
        AuthModule,
        PasswordResetModule,
    ],
    controllers: [AppController],
    providers: [AppService],
})
export class AppModule {}
