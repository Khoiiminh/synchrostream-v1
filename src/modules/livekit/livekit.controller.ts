import {
    Body,
    Controller,
    Param,
    Post,
    Request,
    UseGuards,
} from "@nestjs/common";
import {
    ApiBearerAuth,
    ApiOperation,
    ApiResponse,
    ApiTags,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "@/shared/auth/jwt-auth.guard.js";
import { LiveKitService } from "./livekit.service.js";
import { CreateMediaSessionDto } from "./media-session.dto.js";
import type { AuthenticatedRequest } from "@/shared/auth/auth-context.types.js";

@ApiTags("LiveKit")
@ApiBearerAuth("JWT-auth")
@Controller("livekit")
@UseGuards(JwtAuthGuard)
export class LiveKitController {
    constructor(private readonly liveKitService: LiveKitService) {}

    @Post("media-sessions/create")
    @ApiOperation({
        summary: "Create and start a LiveKit MediaSession",
        description:
            "Creates a MediaSession for the specified watch room, creates the corresponding LiveKit room, and activates the MediaSession.",
    })
    @ApiResponse({
        status: 201,
        description: "MediaSession and LiveKit room created successfully.",
    })
    @ApiResponse({
        status: 404,
        description: "The requested watch room does not exist.",
    })
    @ApiResponse({
        status: 409,
        description:
            "The watch room already has an active MediaSession or the MediaSession cannot be started.",
    })
    @ApiResponse({
        status: 403,
        description:
            "The caller is not an active member of the active watch room.",
    })
    async createMediaSession(
        @Body() dto: CreateMediaSessionDto,
        @Request() request: AuthenticatedRequest,
    ) {
        // Idempotent: returns the room's existing ACTIVE session when present.
        return this.liveKitService.getOrCreateMediaSessionForMember(
            dto.roomId,
            request.user.id,
        );
    }

    @Post("media-sessions/:mediaSessionId/connect")
    @ApiOperation({
        summary: "Create LiveKit connection credentials",
        description:
            "Authorizes the authenticated room participant and returns the LiveKit connection information required by the frontend.",
    })
    @ApiResponse({
        status: 201,
        description: "LiveKit connection credentials created successfully.",
    })
    @ApiResponse({
        status: 404,
        description: "MediaSession or room participant was not found.",
    })
    @ApiResponse({
        status: 409,
        description: "MediaSession is not active.",
    })
    async connectMediaSession(
        @Param("mediaSessionId") mediaSessionId: string,
        @Request() request: AuthenticatedRequest,
    ) {
        return this.liveKitService.createMediaSessionConnection(
            mediaSessionId,
            request.user.id,
        );
    }
}
