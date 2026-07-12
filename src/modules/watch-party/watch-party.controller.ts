import { BadRequestException, Body, Controller, Get, Logger, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { RolesGuard } from "../auth/roles.guard.js";
import { Roles } from "../auth/roles.decorator.js";
import { LiveKitTokenService } from "./livekit-token.service.js";
import { ConfigService } from "@nestjs/config";
import { CreateRoomDto, WatchPartyService } from "./watch-party.service.js";

@ApiTags('Watch Party Collaborator')
@ApiBearerAuth('JWT-auth')
@Controller('watch-party')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('USER')
export class WatchPartyController {
    private readonly logger = new Logger(WatchPartyController.name);

    constructor(
        private readonly livekitTokenService: LiveKitTokenService,
        private readonly configService: ConfigService,
        private readonly watchPartyService: WatchPartyService,
    ) {}

    @Get('rtc-token')
    @ApiOperation({ summary: 'Request cryptographically signed token for direct LiveKit WebRTC peer hookup' })
    @ApiQuery({ name: 'roomCode', description: 'The 6-character unique string identifier' })
    async getRtcToken(@Query('roomCode') roomCode: string, @Req() req: any) {
        const user = req.user;  // Injected via token payload on JwtAuthGuard passing

        if (!roomCode || roomCode.length !== 6) {
            this.logger.warn({ 
                message: 'Rejected token dispatch: Structural layout code error', 
                providedCode: roomCode, 
                userId: user?.id 
            });
            throw new BadRequestException('Invalid room tracking code structural layout.');
        }

        const tokenJwt = await this.livekitTokenService.grantParticipantToken({
            roomCode: roomCode,
            identity: user.id,
            username: user.username
        });

        return {
            livekitUrl: this.configService.get<string>('LIVEKIT_URL') || 'ws://localhost:7880',
            token: tokenJwt
        }
    }

    @Post('rooms')
    @ApiOperation({ summary: 'Provision a persistent PostgreSQL room registry record as a host' })
    async createRoom(@Body() dto: CreateRoomDto, @Req() req: any) {
        return this.watchPartyService.createRoomSession({ dto, ownerId: req.user.id });
    }
}   