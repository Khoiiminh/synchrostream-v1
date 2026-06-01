import { RedisBlacklistProvider } from "@/shared/infrastructure/cache/redis-blacklist.provider.js";
import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
    private readonly logger = new Logger(JwtStrategy.name);

    constructor(
        private readonly config: ConfigService,
        private readonly blacklist: RedisBlacklistProvider,
    ) {
        super({
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            ignoreExpiration: false,
            secretOrKey: config.get<string>('JWT_SECRET')!,
            passReqToCallback: true,    // allow to see the raw token
        });
    }

    async validate(req: any, payload: any) {
        this.logger.debug(`Validating JWT for user: ${payload.username} (ID: ${payload.sub})`);

        const token = ExtractJwt.fromAuthHeaderAsBearerToken()(req);

        if (!token || await this.blacklist.has(token)) {
            this.logger.warn(`Blacklisted token attempt by user: ${payload.username}`);
            throw new UnauthorizedException('This session has been revoked');
        }
        
        if (!payload.sub || !payload.role) {
            this.logger.error(`JWT Payload is missing critical claims: ${JSON.stringify(payload)}`);
            throw new UnauthorizedException('Malformed token payload');
        }

        return { id: payload.sub, username: payload.username, role: payload.role };
    }
}