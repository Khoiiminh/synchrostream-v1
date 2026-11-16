import { RedisBlacklistProvider } from "@/shared/infrastructure/cache/redis-blacklist.provider.js";
import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import type { Request } from "express";
import { ExtractJwt, Strategy } from "passport-jwt";
import type { AuthenticatedUser, JwtPayload } from "../auth.types.js";

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
            secretOrKey: config.get<string>("JWT_SECRET")!,
            passReqToCallback: true, // allow to see the raw token
        });
    }

    async validate(
        req: Request,
        payload: Partial<JwtPayload>,
    ): Promise<AuthenticatedUser> {
        this.logger.debug({ message: "Validating JWT", userId: payload.sub });

        const token = ExtractJwt.fromAuthHeaderAsBearerToken()(req);

        if (!token || (await this.blacklist.has(token))) {
            this.logger.warn({
                message: "Rejected blacklisted token",
                userId: payload.sub,
            });
            throw new UnauthorizedException("This session has been revoked");
        }

        if (!payload.sub || !payload.role) {
            this.logger.warn({
                message: "Rejected JWT with missing claims",
                claims: Object.keys(payload ?? {}),
            });
            throw new UnauthorizedException("Malformed token payload");
        }

        return {
            id: payload.sub,
            username: payload.username ?? "",
            role: payload.role,
        };
    }
}
