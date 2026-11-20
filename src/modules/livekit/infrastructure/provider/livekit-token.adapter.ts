import { Inject, Injectable } from "@nestjs/common";
import { AccessToken } from "livekit-server-sdk";
import { LIVEKIT_CONFIG, type LiveKitConfig } from "./livekit.config.js";
import type {
    ParticipantTokenPort,
    ParticipantTokenRequest,
} from "../../application/ports/collaborators.port.js";

/** ParticipantTokenPort: signs room-join tokens with the API key and secret. */
@Injectable()
export class LiveKitTokenAdapter implements ParticipantTokenPort {
    constructor(
        @Inject(LIVEKIT_CONFIG)
        private readonly config: LiveKitConfig,
    ) {}

    get serverUrl(): string {
        return this.config.url;
    }

    async createParticipantToken(
        request: ParticipantTokenRequest,
    ): Promise<string> {
        const token = new AccessToken(
            this.config.apiKey,
            this.config.apiSecret,
            {
                identity: request.participantIdentity,
                ttl: request.ttl,
            },
        );

        token.addGrant({
            roomJoin: true,
            room: request.roomName,
            canPublish: request.canPublish,
            canSubscribe: request.canSubscribe,
            canPublishData: request.canPublishData,
        });

        return await token.toJwt();
    }
}
