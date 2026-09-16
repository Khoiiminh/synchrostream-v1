import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";

export interface SfuSignalingTokenPayload {
    sub: string;
    mediaSessionId: string;
    participantId: string;
    nodeId: string;
}

@Injectable()
export class SfuSignalingTokenService {
    constructor(
        private readonly jwtService: JwtService,
        private readonly configService: ConfigService,
    ) {}

    generateToken(payload: SfuSignalingTokenPayload): string {
        const secret = this.configService.get<string>("SFU_SIGNALING_JWT_SECRET");

        if (!secret) {
            throw new Error(
                "SFU_SIGNALING_JWT_SECRET is not defined in .env.development",
            );
        }

        return this.jwtService.sign(
            payload,
            {
                secret,
                expiresIn: "5m",
            },
        );
    }
}