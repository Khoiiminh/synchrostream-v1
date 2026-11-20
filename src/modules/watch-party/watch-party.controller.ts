import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpException,
    Logger,
    NotFoundException,
    Param,
    ParseUUIDPipe,
    Post,
    Req,
    UseGuards,
} from "@nestjs/common";
import {
    ApiBearerAuth,
    ApiOperation,
    ApiResponse,
    ApiTags,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "@/shared/auth/jwt-auth.guard.js";
import { RolesGuard } from "@/shared/auth/roles.guard.js";
import { Roles } from "@/shared/auth/roles.decorator.js";
import { CreateRoomDto, WatchPartyService } from "./watch-party.service.js";
import { WatchPartyGateway } from "./watch-party.gateway.js";
import type { AuthenticatedRequest } from "@/shared/auth/auth-context.types.js";

/** Conflicts that a confirmed `leaveCurrent` request may resolve by leaving that room. */
const SWITCHABLE_CONFLICTS = new Set([
    "ACTIVE_OWNER_ROOM",
    "ACTIVE_MEMBERSHIP_ELSEWHERE",
]);

@ApiTags("Watch Party Collaborator")
@ApiBearerAuth("JWT-auth")
@Controller("watch-party")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("USER")
export class WatchPartyController {
    private readonly logger = new Logger(WatchPartyController.name);

    constructor(
        private readonly watchPartyService: WatchPartyService,
        private readonly watchPartyGateway: WatchPartyGateway,
    ) {}

    @Post("rooms")
    @ApiOperation({
        summary:
            "Provision a persistent PostgreSQL room registry record as a host",
    })
    @ApiResponse({
        status: 409,
        description:
            "ACTIVE_OWNER_ROOM / ACTIVE_MEMBERSHIP_ELSEWHERE (retry with leaveCurrent: true after the user confirms), or ROOM_CODE_IN_USE.",
    })
    async createRoom(
        @Body() dto: CreateRoomDto,
        @Req() req: AuthenticatedRequest,
    ) {
        const ownerId: string = req.user.id;
        try {
            return await this.watchPartyService.createRoomSession({
                dto,
                ownerId,
            });
        } catch (error) {
            const detail = this.getConflictDetail(error);
            if (
                !dto.leaveCurrent ||
                !detail?.roomId ||
                !SWITCHABLE_CONFLICTS.has(detail.code)
            ) {
                throw error;
            }

            // The user confirmed leaving (and, as owner, closing) their current
            // room. Leave it with the same immediate path as the Leave button,
            // then create once more.
            this.logger.log({
                message: "Creating a room after leaving the current one",
                ownerId,
                leftRoomId: detail.roomId,
                conflict: detail.code,
            });
            await this.watchPartyGateway.leaveRoomVoluntarily(
                ownerId,
                detail.roomId,
            );
            return await this.watchPartyService.createRoomSession({
                dto,
                ownerId,
            });
        }
    }

    @Post("rooms/:roomId/leave")
    @HttpCode(200)
    @ApiOperation({
        summary: "Leave a watch room immediately (voluntary leave)",
        description:
            "Fallback for the room:leave socket event when the socket is unavailable. " +
            "An owner leaving terminates the room; a participant leaving ends only their membership. Idempotent.",
    })
    async leaveRoom(
        @Param("roomId", new ParseUUIDPipe()) roomId: string,
        @Req() req: AuthenticatedRequest,
    ) {
        const status = await this.watchPartyGateway.leaveRoomVoluntarily(
            req.user.id,
            roomId,
        );
        return { status };
    }

    @Get("rooms/:roomCode")
    @ApiOperation({
        summary: "Resolve active room configuration metadata by room code",
    })
    @ApiResponse({
        status: 200,
        description: "Room data resolved successfully.",
    })
    @ApiResponse({ status: 404, description: "Active room session not found." })
    async getRoomByCode(@Param("roomCode") roomCode: string) {
        const room =
            await this.watchPartyService.getRoomDetailsByCode(roomCode);

        if (!room) {
            throw new NotFoundException(
                `No active room found with code: ${roomCode}`,
            );
        }

        return room;
    }

    private getConflictDetail(
        error: unknown,
    ): { code: string; roomId?: string } | null {
        if (!(error instanceof HttpException)) return null;
        const body = error.getResponse() as { error?: unknown };
        const detail =
            typeof body === "object" && body !== null ? body.error : null;
        if (
            typeof detail !== "object" ||
            detail === null ||
            !("code" in detail)
        )
            return null;
        return detail as { code: string; roomId?: string };
    }
}
