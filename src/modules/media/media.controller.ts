import { Controller, Get, HttpStatus, Logger, Param, ParseUUIDPipe, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { RolesGuard } from "../auth/roles.guard.js";
import { Roles } from "../auth/roles.decorator.js";
import { MediaService } from "./media.service.js";

@ApiTags('Media Discovery')
@ApiBearerAuth('JWT-auth')
@Controller('media')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('USER')
export class MediaController {
    private readonly logger = new Logger(MediaController.name);

    constructor(
        private readonly mediaService: MediaService,
    ) {}

    @Get('stream/:id')
    @ApiOperation({ summary: 'Request individual stream metadata and temporary master manifest access keys' })
    @ApiResponse(
        { 
            status: HttpStatus.OK, 
            description: 'Pre-signed adaptive manifest resolved successfully.' 
    })
    async getSoloStream(@Param('id', ParseUUIDPipe) movieId: string) {
        this.logger.log({ message: 'Inbound GET HTTP solo playback request received', movieId });
        return await this.mediaService.resolveSoloPlayback(movieId);
    }

    @Get('catalog')
    @ApiOperation({ summary: 'List all available, transcoded assets for catalog selection' })
    @ApiResponse({ 
        status: HttpStatus.OK, 
        description: 'Active movie registry list compiled successfully.' 
    })
    async getCatalog() {
        return await this.mediaService.getAvailableCatalog();
    }
}