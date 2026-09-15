import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export interface CreateSfuMediaSessionRequest {
    mediaSessionId: string;
    assignedSfuNodeId: string;
}

export interface CreateSfuMediaSessionResponse {
    mediaSessionId: string;
    assignedSfuNodeId: string;
}

@Injectable()
export class SfuControlClient {
    private readonly logger = new Logger(SfuControlClient.name);

    constructor(
        private readonly configService: ConfigService,
    ) {}

    async createMediaSession(
        endpoint: string,
        request: CreateSfuMediaSessionRequest,
    ): Promise<CreateSfuMediaSessionResponse> {
        const baseUrl = endpoint.replace(/\/$/, "");
        const secret = this.getSecret();

        const response = await fetch(
            `${baseUrl}/control/media-sessions`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${secret}`,
                },
                body: JSON.stringify(request),
            },
        );

        if (!response.ok) {
            const message = await response.text();

            this.logger.error({
                message: "SFU MediaSession creation failed",
                mediaSessionId: request.mediaSessionId,
                assignedSfuNodeId: request.assignedSfuNodeId,
                status: response.status,
                response: message,
            });

            throw new Error(
                `SFU MediaSession creation failed with status ${response.status}.`,
            );
        }

        return await response.json() as CreateSfuMediaSessionResponse;
    }

    async endMediaSession(
        endpoint: string,
        mediaSessionId: string,
    ): Promise<void> {
        const baseUrl = endpoint.replace(/\/$/, "");
        const secret = this.getSecret();

        const response = await fetch(
            `${baseUrl}/control/media-sessions/${mediaSessionId}`,
            {
                method: "DELETE",
                headers: {
                    Authorization: `Bearer ${secret}`,
                },
            },
        );

        if (!response.ok) {
            const message = await response.text();

            this.logger.error({
                message: "SFU MediaSession termination failed",
                mediaSessionId,
                status: response.status,
                response: message,
            });

            throw new Error(
                `SFU MediaSession termination failed with status ${response.status}.`,
            );
        }
    }


    async getHealth(endpoint: string): Promise<unknown> {
        const baseUrl = endpoint.replace(/\/$/, "");
        const secret = this.getSecret();

        const response = await fetch(
            `${baseUrl}/control/health`,
            {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${secret}`,
                },
            },
        );

        if (!response.ok) {
            const message = await response.text();

            this.logger.error({
                message: "SFU health check failed",
                endpoint,
                status: response.status,
                response: message,
            });

            throw new Error(
                `SFU health check failed with status ${response.status}.`,
            );
        }

        return await response.json();
    }

    private getSecret(): string {
        const secret = this.configService.get<string>('SFU_CONTROL_SECRET');

        if (!secret) {
            throw new Error(
                'SFU_CONTROL_SECRET is not defined in .env.development',
            );
        }

        return secret;
    }
}