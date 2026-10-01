import { ApiProperty } from "@nestjs/swagger";
import { IsUrl, IsUUID } from "class-validator";

export class MediaSessionConnectionDto {
    @ApiProperty({
        description: "UUID of the MediaSession.",
        format: "uuid",
    })
    @IsUUID()
    mediaSessionId!: string;

    @ApiProperty({
        description: "UUID of the participant authorized to join the MediaSession.",
        format: "uuid",
    })
    @IsUUID()
    participantId!: string;

    @ApiProperty({
        description: "Stable application identity of the assigned SFU node.",
        example: "sfu-01",
    })
    sfuNodeId!: string;

    @ApiProperty({
        description: "WebSocket signaling endpoint of the assigned SFU node.",
        example: "ws://localhost:4001",
    })
    @IsUrl({
        require_tld: false,
        protocols: ["ws", "wss"],
    })
    signalingEndpoint!: string;

    @ApiProperty({
        description: "Short-lived JWT used by the browser to authenticate with the SFU signaling server.",
    })
    signalingToken!: string;
}