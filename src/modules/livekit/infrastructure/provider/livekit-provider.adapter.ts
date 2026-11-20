import { Inject, Injectable } from "@nestjs/common";
import type { MediaProviderPort } from "../../application/ports/collaborators.port.js";

/** The slice of livekit-server-sdk's RoomServiceClient this adapter uses. */
export interface LiveKitRoomApi {
    createRoom(options: {
        name: string;
        maxParticipants: number;
    }): Promise<unknown>;
    deleteRoom(roomName: string): Promise<void>;
    listParticipants(roomName: string): Promise<{ identity: string }[]>;
    removeParticipant(roomName: string, identity: string): Promise<void>;
}

/** Provided by livekit.config.ts from the SDK's LiveKitAPI. */
export const LIVEKIT_ROOM_API = Symbol("LIVEKIT_ROOM_API");

/**
 * Whether a LiveKit API error means the room or participant does not exist.
 * The SDK reports this in several shapes depending on transport and version.
 */
export function isProviderNotFound(error: unknown): boolean {
    const providerError = error as {
        statusCode?: number;
        status?: number;
        code?: number | string;
        message?: string;
    };
    return (
        providerError?.statusCode === 404 ||
        providerError?.status === 404 ||
        providerError?.code === 404 ||
        providerError?.code === "NOT_FOUND" ||
        providerError?.code === "not_found" ||
        /(room|participant).*(not found|does not exist)/i.test(
            providerError?.message ?? "",
        )
    );
}

/** MediaProviderPort on the LiveKit server API. Room names are media-session ids. */
@Injectable()
export class LiveKitProviderAdapter implements MediaProviderPort {
    constructor(
        @Inject(LIVEKIT_ROOM_API)
        private readonly rooms: LiveKitRoomApi,
    ) {}

    async createRoom(roomName: string, maxParticipants: number): Promise<void> {
        await this.rooms.createRoom({
            name: roomName,
            maxParticipants,
        });
    }

    async deleteRoomIfPresent(roomName: string): Promise<void> {
        try {
            await this.rooms.deleteRoom(roomName);
        } catch (error) {
            if (isProviderNotFound(error)) return;
            throw error;
        }
    }

    async listParticipantIdentities(
        roomName: string,
    ): Promise<string[] | null> {
        try {
            const participants = await this.rooms.listParticipants(roomName);
            return participants.map((p) => p.identity);
        } catch (error) {
            if (isProviderNotFound(error)) return null;
            throw error;
        }
    }

    async removeParticipantIfPresent(
        roomName: string,
        identity: string,
    ): Promise<boolean> {
        try {
            await this.rooms.removeParticipant(roomName, identity);
            return true;
        } catch (error) {
            if (isProviderNotFound(error)) return false;
            throw error;
        }
    }
}
