import { Inject, Injectable } from "@nestjs/common";
import { LIVEKIT_CONFIG, type CreateLiveKitTokenOptions, type LiveKitConfig } from "./livekit.types.js";
import { AccessToken } from "livekit-server-sdk";

@Injectable()
export class LiveKitTokenService {
    constructor (
        @Inject(LIVEKIT_CONFIG)
        private readonly config: LiveKitConfig,
    ) {}

    public async createParticipantToken(options: CreateLiveKitTokenOptions): Promise<string> {
        const token = new AccessToken(
            this.config.apiKey,
            this.config.apiSecret,
            {
                identity: options.participantIdentity,
                name: options.participantName,
                ttl: options.ttl,
            },
        );

        token.addGrant({
            roomJoin: true,
            room: options.roomName,
            canPublish: options.canPublish ?? true,
            canSubscribe: options.canSubscribe ?? true,
            canPublishData: options.canPublishData ?? true,
        });

        return await token.toJwt();
    }
}