import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Param,
    Patch,
    Post,
    Query,
    Req,
    UseGuards,
} from "@nestjs/common";
import {
    ApiBearerAuth,
    ApiOperation,
    ApiQuery,
    ApiTags,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { RolesGuard } from "../auth/roles.guard.js";
import { Roles } from "../auth/roles.decorator.js";
import { SyncMetricsBatchDto, UpdateSyncRunDto } from "./sync-metrics.dto.js";
import { SyncMetricsService } from "./sync-metrics.service.js";
import type { AuthenticatedRequest } from "../auth/auth.types.js";

/**
 * Any signed-in party participant can upload measurements; only admins can
 * read, annotate or delete runs.
 */
@ApiTags("Sync Metrics (research instrumentation)")
@ApiBearerAuth("JWT-auth")
@Controller("sync-metrics")
@UseGuards(JwtAuthGuard)
export class SyncMetricsController {
    constructor(private readonly service: SyncMetricsService) {}

    @Post("batches")
    @HttpCode(202)
    @ApiOperation({
        summary:
            "Append a batch of drift samples and sync events for a measurement run",
    })
    async ingest(
        @Body() dto: SyncMetricsBatchDto,
        @Req() req: AuthenticatedRequest,
    ) {
        return this.service.appendBatch(req.user.id, dto);
    }

    @Get("runs")
    @UseGuards(RolesGuard)
    @Roles("ADMIN")
    @ApiOperation({ summary: "List stored measurement runs with metadata" })
    async listRuns() {
        return { runs: await this.service.listRuns() };
    }

    @Get("runs/:runId")
    @UseGuards(RolesGuard)
    @Roles("ADMIN")
    @ApiQuery({
        name: "since",
        required: false,
        description: "Only records received after this server time (ms)",
    })
    @ApiOperation({ summary: "Return the records of a run (all participants)" })
    async readRun(
        @Param("runId") runId: string,
        @Query("since") since?: string,
    ) {
        const sinceMs =
            since !== undefined && since !== "" ? Number(since) : undefined;
        return this.service.readRun(
            runId,
            Number.isFinite(sinceMs) ? sinceMs : undefined,
        );
    }

    @Patch("runs/:runId")
    @UseGuards(RolesGuard)
    @Roles("ADMIN")
    @ApiOperation({ summary: "Update a run's notes and tags" })
    async updateRun(
        @Param("runId") runId: string,
        @Body() dto: UpdateSyncRunDto,
    ) {
        return { meta: await this.service.updateRun(runId, dto) };
    }

    @Delete("runs/:runId")
    @UseGuards(RolesGuard)
    @Roles("ADMIN")
    @ApiOperation({ summary: "Permanently delete a run and all its records" })
    async deleteRun(@Param("runId") runId: string) {
        return this.service.deleteRun(runId);
    }
}
