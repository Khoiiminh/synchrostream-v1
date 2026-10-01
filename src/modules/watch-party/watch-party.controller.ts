import { BadRequestException, Body, Controller, Get, Logger, NotFoundException, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { RolesGuard } from "../auth/roles.guard.js";
import { Roles } from "../auth/roles.decorator.js";
import { CreateRoomDto, WatchPartyService } from "./watch-party.service.js";

@ApiTags('Watch Party Collaborator')
@ApiBearerAuth('JWT-auth')
@Controller('watch-party')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('USER')
export class WatchPartyController {
    private readonly logger = new Logger(WatchPartyController.name);

    constructor(
        private readonly watchPartyService: WatchPartyService,
    ) {}

    @Post('rooms')
    @ApiOperation({ summary: 'Provision a persistent PostgreSQL room registry record as a host' })
    async createRoom(@Body() dto: CreateRoomDto, @Req() req: any) {
        return this.watchPartyService.createRoomSession({ dto, ownerId: req.user.id });
    }

    @Get('rooms/:roomCode')
    @ApiOperation({ summary: 'Resolve active room configuration metadata by room code' })
    @ApiResponse({ status: 200, description: 'Room data resolved successfully.' })
    @ApiResponse({ status: 404, description: 'Active room session not found.' })
    async getRoomByCode(@Param('roomCode') roomCode: string) {
        const room = await this.watchPartyService.getRoomDetailsByCode(roomCode);
        
        if (!room) {
            throw new NotFoundException(`No active room found with code: ${roomCode}`);
        }
        
        return room;
    }
}   