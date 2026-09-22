import { ApiProperty } from "@nestjs/swagger";
import { IsUUID } from "class-validator";

export class CreateMediaSessionDto {
    @ApiProperty({
        description: 'UUID of the watch room for which the media session is created',
        format: 'uuid',
    })
    @IsUUID()
    roomId!: string;
}