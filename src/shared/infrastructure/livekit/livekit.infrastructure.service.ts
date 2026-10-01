import { Inject, Injectable } from "@nestjs/common";
import { LiveKitAPI, ParticipantInfo, Room } from "livekit-server-sdk";
import { LIVEKIT_CONFIG, type LiveKitConfig } from "./livekit.types.js";

@Injectable()
export class LiveKitInfrastructureService {
    private readonly api: LiveKitAPI;

    constructor(
        @Inject(LIVEKIT_CONFIG)
        private readonly config: LiveKitConfig
    ) {
        this.api = new LiveKitAPI({
            host: this.getApiHost(),
            apiKey: config.apiKey,
            secret: config.apiSecret,
        });
    }

    public async createRoom (roomName: string, maxParticipants: number): Promise<Room> {
        return await this.api.room.createRoom({
            name: roomName,
            maxParticipants,
        });
    }

    public async deleteRoom (roomName: string): Promise<void> {
        await this.api.room.deleteRoom(roomName);
    }

    public async listParticipants (roomName: string): Promise<ParticipantInfo[]> {
        return await this.api.room.listParticipants(roomName);
    }

    public async getParticipant (roomName: string, participantIdentity: string): Promise<ParticipantInfo> {
        return await this.api.room.getParticipant(roomName, participantIdentity);
    } 

    private getApiHost (): string {
        return this.config.url.replace(/^ws/, "http");
    }
}