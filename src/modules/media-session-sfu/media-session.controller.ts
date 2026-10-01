import { Body, Controller, Get, Param, Post, Request, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { MediaSessionService } from "./media-session.service.js";
import { CreateMediaSessionDto } from "./dto/media-session.dto.js";
import { MediaOrchestrationService } from "./media-orchestration.service.js";

@ApiTags('Media Session')
@ApiBearerAuth('JWT-auth')
@Controller('media-sessions')
@UseGuards(JwtAuthGuard)
export class MediaSessionController{
    constructor(
        private readonly mediaSessionService: MediaSessionService,
        private readonly mediaOrchestrationService: MediaOrchestrationService,
    ) {}

    @Post()
    @ApiOperation({
        summary: 'Create a control-plane media session',
        description:
            'Creates a MediaSession record for a watch room. This does not create an SFU runtime.',
    })
    @ApiResponse({
        status: 201,
        description: 'MediaSession created successfully.',
    })
    async createMediaSession(
        @Body() dto: CreateMediaSessionDto,
    ) {
        return this.mediaSessionService.createMediaSession(
            dto.roomId,
        );
    }

    @Get(':mediaSessionId')
    @ApiOperation({
        summary: 'Get MediaSession state',
    })
    @ApiResponse({
        status: 200,
        description: 'MediaSession state returned successfully.',
    })
    @ApiResponse({
        status: 404,
        description: 'MediaSession not found.',
    })
    async getMediaSession(
        @Param('mediaSessionId') mediaSessionId: string,
    ) {
        return this.mediaSessionService.getMediaSession(
            mediaSessionId,
        );
    }

    @Post(':mediaSessionId/start')
    @ApiOperation({
        summary: 'Start MediaSession lifecycle',
        description:
            'Transitions the MediaSession from CREATED to STARTING. SFU runtime creation is handled separately.',
    })
    async startMediaSession(
        @Param('mediaSessionId') mediaSessionId: string,
    ) {
        return this.mediaOrchestrationService.startMediaSession(
            mediaSessionId,
        );
    }

    @Post(':mediaSessionId/connect')
    @ApiOperation({
        summary: 'Create MediaSession connection blueprint',
        description:
            'Authorizes the authenticated participant and returns the connection information required to connect directly to the assigned SFU.',
    })
    @ApiResponse({
        status: 201,
        description: 'MediaSession connection blueprint created successfully.',
    })
    @ApiResponse({
        status: 404,
        description:
            'MediaSession, participant, or assigned SFU node was not found.',
    })
    @ApiResponse({
        status: 409,
        description:
            'MediaSession or assigned SFU node is not available for connection.',
    })
    async connectMediaSession(
        @Param('mediaSessionId') mediaSessionId: string,
        @Request() request: any,
    ) {
        return this.mediaOrchestrationService.createMediaSessionConnection(
            mediaSessionId,
            request.user.id,
        );
    }

    @Post(':mediaSessionId/activate')
    @ApiOperation({
        summary: 'Activate MediaSession',
        description:
            'Transitions a MediaSession from STARTING to ACTIVE after its media runtime is ready.',
    })
    async activateMediaSession(
        @Param('mediaSessionId') mediaSessionId: string,
    ) {
        return this.mediaSessionService.activateMediaSession(
            mediaSessionId,
        );
    }

    @Post(':mediaSessionId/end')
    @ApiOperation({
        summary: 'Begin MediaSession shutdown',
    })
    async endMediaSession(
        @Param('mediaSessionId') mediaSessionId: string,
    ) {
        return this.mediaOrchestrationService.endMediaSession(mediaSessionId);
    }

    @Post(':mediaSessionId/complete')
    @ApiOperation({
        summary: 'Complete MediaSession shutdown',
        description:
            'Transitions a MediaSession from ENDING to ENDED after runtime termination.',
    })
    async completeMediaSession(
        @Param('mediaSessionId') mediaSessionId: string,
    ) {
        return this.mediaSessionService.completeMediaSession(
            mediaSessionId,
        );
    }
}