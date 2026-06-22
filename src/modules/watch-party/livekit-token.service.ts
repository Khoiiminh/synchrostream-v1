import { Injectable, InternalServerErrorException, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AccessToken } from "livekit-server-sdk";

@Injectable()
export class LiveKitTokenService implements OnModuleInit {
    private readonly logger = new Logger(LiveKitTokenService.name);
    private readonly apiKey!: string;
    private readonly apiSecret!: string;

    constructor(private readonly configService: ConfigService) {
        this.apiKey = configService.get<string>('LIVEKIT_API_KEY') || '';
        this.apiSecret = configService.get<string>('LIVEKIT_API_SECRET') || '';
    }

    onModuleInit() {
        if (!this.apiKey || !this.apiSecret) {
            this.logger.error({
                message: 'Critical Setup Failure: LiveKit credentials missing from environment configuration.',
                hasApiKey: !!this.apiKey,
                hasApiSecret: !!this.apiSecret
            });
        } else {
            this.logger.log({ message: 'LiveKit Token Engine successfully mounted and configured.' });
        }
    }

    /** 
     * Mints a short-lived cryptographically signed token for the SFU WebRTC channels
     */
    async grantParticipantToken(p: {roomCode: string, identity: string, username: string}): Promise<string> {
        this.logger.log({ 
            message: 'Minting WebRTC access authorization token', 
            username: p.username, 
            roomCode: p.roomCode,
            identity: p.identity 
        });

        try {
            const at = new AccessToken(this.apiKey, this.apiSecret, {
                identity: p.identity,
                name: p.username,
                ttl: '2h',      // 2-Hour short-lived window token lifecycle
            });

            at.addGrant({
                roomJoin: true,
                room: p.roomCode,
                canPublish: true,       // Webcams and Mic streaming
                canSubscribe: true,     // Consuming other peer tracks
                canPublishData: true,   // Low-latency UDP peer data tracks for live chat
            });

            const token = await at.toJwt();
            
            this.logger.debug?.({ message: 'WebRTC token signed cleanly', roomCode: p.roomCode, identity: p.identity });
            return token;
        } catch (error) {
            this.logger.error({ 
                message: 'LiveKit token signing error', 
                roomCode: p.roomCode, 
                identity: p.identity,
                error: (error as Error).message 
            }, (error as Error).stack);
            throw new InternalServerErrorException('Failed to allocate WebRTC media layer tokens.');
        }
    }
}