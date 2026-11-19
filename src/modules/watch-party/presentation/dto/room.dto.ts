import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
    IsBoolean,
    IsInt,
    IsOptional,
    IsString,
    IsUUID,
    Length,
    Matches,
    Max,
    Min,
} from "class-validator";
import {
    ROOM_PASSWORD_MAX_LENGTH,
    ROOM_PASSWORD_MIN_LENGTH,
} from "../../domain/room-password.js";

/* HTTP/socket request shapes and their validation. Moved from watch-party.service.ts (phase 3). */

export class CreateRoomDto {
    @ApiProperty({
        description:
            "Optional explicit 6-character room code. Omit it to let the server generate a unique code.",
        example: "A1B2C3",
        required: false,
    })
    @IsOptional()
    @IsString()
    @Length(6, 6)
    @Matches(/^[A-Za-z0-9]{6}$/)
    roomCode?: string;

    @ApiProperty({
        description: "Plain text password constraint challenge signature",
        example: "SecurePass123",
        minLength: ROOM_PASSWORD_MIN_LENGTH,
        maxLength: ROOM_PASSWORD_MAX_LENGTH,
    })
    @IsString()
    @Length(ROOM_PASSWORD_MIN_LENGTH, ROOM_PASSWORD_MAX_LENGTH)
    @Matches(/\S/, { message: "Room password cannot be blank." })
    passwordPlain!: string;

    @ApiProperty({
        description: "The unique UUID matching the ingested target film entity",
    })
    @IsUUID() // Explicitly enforce UUID format check if it matches database IDs
    @IsString()
    movieId!: string;

    @ApiProperty({
        description:
            "Leave the room the caller is currently in (closing it if they own it) and then create this one. Sent after the user confirms the ACTIVE_OWNER_ROOM / ACTIVE_MEMBERSHIP_ELSEWHERE conflict.",
        required: false,
        default: false,
    })
    @IsOptional()
    @IsBoolean()
    leaveCurrent?: boolean;

    @ApiProperty({
        description: "Maximum participant threshold allocation",
        default: 5,
        required: false,
    })
    @IsOptional()
    @Type(() => Number) // FORCE execution transformation to cast incoming payload elements safely
    @IsInt()
    @Min(1)
    @Max(20)
    maxParticipants?: number;
}

export class JoinRoomDto {
    @ApiProperty({
        description:
            "Target 6-character room code to match against active sessions",
        example: "A1B2C3",
    })
    @IsString()
    @Length(6, 6)
    roomCode!: string;

    @ApiProperty({
        description:
            "Plain text password entry to verify against target room authorization",
        example: "SecurePass123",
    })
    @IsString()
    passwordPlain!: string;
}
