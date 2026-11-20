import type { Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { LiveKitAPI } from "livekit-server-sdk";
import {
    LIVEKIT_ROOM_API,
    type LiveKitRoomApi,
} from "./livekit-provider.adapter.js";

export interface LiveKitConfig {
    url: string;
    apiKey: string;
    apiSecret: string;
}

export const LIVEKIT_CONFIG = Symbol("LIVEKIT_CONFIG");

/** LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET; startup fails if any is missing. */
export const LIVEKIT_CONFIG_PROVIDER: Provider = {
    provide: LIVEKIT_CONFIG,
    inject: [ConfigService],
    useFactory: (configService: ConfigService): LiveKitConfig => {
        const url = configService.get<string>("LIVEKIT_URL");
        const apiKey = configService.get<string>("LIVEKIT_API_KEY");
        const apiSecret = configService.get<string>("LIVEKIT_API_SECRET");

        if (!url) {
            throw new Error("LIVEKIT_URL is not configured.");
        }

        if (!apiKey) {
            throw new Error("LIVEKIT_API_KEY is not configured.");
        }

        if (!apiSecret) {
            throw new Error("LIVEKIT_API_SECRET is not configured.");
        }

        return {
            url,
            apiKey,
            apiSecret,
        };
    },
};

/** The SDK's room service, talking HTTP(S) to the same host clients reach over WS(S). */
export const LIVEKIT_ROOM_API_PROVIDER: Provider = {
    provide: LIVEKIT_ROOM_API,
    inject: [LIVEKIT_CONFIG],
    useFactory: (config: LiveKitConfig): LiveKitRoomApi =>
        new LiveKitAPI({
            host: config.url.replace(/^ws/, "http"),
            apiKey: config.apiKey,
            secret: config.apiSecret,
        }).room,
};
