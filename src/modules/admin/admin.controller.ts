import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  ParseIntPipe,
  Patch,
  Post,
  Request,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { RolesGuard } from "../auth/roles.guard.js";
import { Roles } from "../auth/roles.decorator.js";
import { AdminIngestionService } from "./admin-ingestion.service.js";
import { CompleteUploadDto, InitiateUploadDto } from "./media-ingestion.dto.js";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Multer } from "multer";
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { StartTranscodeDto } from "./transcode.dto.js";
import { AdminTranscodingService } from "./admin-transcoding.service.js";

@ApiTags("Admin Panel")
@ApiBearerAuth("JWT-auth")
@Controller("admin/media")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("ADMIN")
export class AdminController {
  private readonly logger = new Logger(AdminController.name);
  constructor(
    private readonly ingestionService: AdminIngestionService,
    private readonly transcodingService: AdminTranscodingService,
  ) {}

  @Post("initiate")
  @ApiOperation({
    summary: 'Initiate a new multipart upload session',
    description: "Registers a new film record in PostgreSQL and starts a high-performance multipart session on Cloudflare R2."
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Ingestion pipeline initialized successfully.',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        message: { type: 'string', example: "Request processed successfully" },
        data: {
          type: 'object',
          properties: {
            movieId: { type: 'string', format: 'uuid', example: "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d" },
            uploadId: { type: 'string', example: "MP_UPLOAD_ID_EXAMPLE_12345" },
            objectKey: { type: 'string', example: "raw-mezzanines/1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d.mp4" }
          }
        },
        timestamp: { type: 'string', format: 'date-time', example: "2026-06-02T14:41:58.000Z" }
      }
    }
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Missing, expired, or corrupted JWT signature token.",
    schema: {
      type: "object",
      properties: {
        success: { type: "boolean", example: false },
        message: { type: "string", example: "Unauthorized" },
        data: { type: "string", example: "Unauthorized", nullable: true },
        timestamp: { type: "string", format: "date-time", example: "2026-06-02T14:41:58.000Z" }
      }
    }
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: "Privilege execution rejected: User account lacks ADMIN role status.",
    schema: {
      type: "object",
      properties: {
        success: { type: "boolean", example: false },
        message: { type: "string", example: "Forbidden resource" },
        data: { type: "string", example: "Forbidden", nullable: true },
        timestamp: { type: "string", format: "date-time", example: "2026-06-02T14:41:58.000Z" }
      }
    }
  })
  @HttpCode(HttpStatus.CREATED)
  async initiateUpload(@Body() dto: InitiateUploadDto, @Request() req: any) {
    this.logger.log(`Admin ${req.user.id} is initiating multi-part upload for movie: ${dto.title}`,);

    const metadata = await this.ingestionService.initiateMovieUpload(dto);
    return {
      message: "Multipart session mapped successfully.",
      data: metadata,
    };
  }

  @Patch("upload-part")
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor("file"))
  @ApiConsumes("multipart/form-data")
  @ApiOperation({ 
    summary: "Transmit Raw Video Stream Chunk Partition", 
    description: "Streams an isolated chunk partition to R2 storage for chunked buffering orchestration." 
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["movieId", "uploadId", "partNumber", "file"],
      properties: {
        movieId: { type: "string", format: "uuid", description: "Target movie entry tracking identifier", example: "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d" },
        uploadId: { type: "string", description: "Active session upload signature key", example: "MP_UPLOAD_ID_EXAMPLE_12345" },
        partNumber: { type: "integer", minimum: 1, description: "Chunk layout processing index order sequence", example: 1 },
        file: { type: "string", format: "binary", description: "Raw binary buffer content segment chunk" },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Chunk segment index received and registered successfully.",
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        message: { type: 'string', example: "Request processed successfully" },
        data: {
          type: 'object',
          properties: {
            etag: { type: 'string', example: '"e1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6"' }
          }
        },
        timestamp: { type: 'string', format: 'date-time' }
      }
    }
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: "Validation failed or upload transmission stream interrupted.",
    schema: {
      type: "object",
      properties: {
        success: { type: "boolean", example: false },
        message: { type: "string", example: "Multipart payload parsing exception: missing valid binary payload." },
        data: { type: "object", example: null, nullable: true },
        timestamp: { type: "string", format: "date-time" }
      }
    }
  })
  async uploadPart(
    @Body("movieId") movieId: string,
    @Body("uploadId") uploadId: string,
    @Body("partNumber", ParseIntPipe) partNumber: number,
    @UploadedFile() file: Express.Multer.File,
    @Request() req: any,
  ) {
    this.logger.debug(`Admin ${req.user.id} uploading part ${partNumber} for Movie ${movieId}`);

    if (!file || !file.buffer) {
        this.logger.error(`Upload failed: Missing binary payload for part ${partNumber}`);
        throw new Error(
            "Multipart payload parsing exception: missing valid binary payload.",
        );
    }

    const allocation = await this.ingestionService.processChunkIngestion({
      movieId: movieId,
      uploadId: uploadId,
      partNumber: partNumber,
      fileBuffer: file.buffer,
    });

    return {
      message: `Chunk segment index ${partNumber} received and registered successfully.`,
      data: allocation,
    };
  }

  @Post("complete")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ 
    summary: "Consolidate Ingested Video Parts", 
    description: "Finalizes the multi-part session on Cloudflare R2 to output the raw master mezzanine file." 
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Multipart upload sequence successfully consolidated on R2.",
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        message: { type: 'string', example: "Request processed successfully" },
        data: {
          type: 'object',
          properties: {
            message: { type: 'string', example: "Mezzanine master file successfully consolidated on storage bucket." },
            objectKey: { type: 'string', example: "raw-mezzanines/1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d.mp4" }
          }
        },
        timestamp: { type: 'string', format: 'date-time' }
      }
    }
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: "Validation failure or parts dictionary structural collation exception.",
    schema: {
      type: "object",
      properties: {
        success: { type: "boolean", example: false },
        message: { type: "string", example: "Validation failed" },
        data: { type: "array", items: { type: "string" }, example: ["parts.0.ETag must be a string"] },
        timestamp: { type: "string", format: "date-time" }
      }
    }
  })
  async completeUpload(@Body() dto: CompleteUploadDto) {
    this.logger.log(`Finalizing multipart upload sequence for Movie ID: ${dto.movieId}`);

    const confirmation = await this.ingestionService.finalizeMovieUpload({
      movieId: dto.movieId,
      uploadId: dto.uploadId,
      parts: dto.parts,
    });

    return {
      message: "Ingestion pipeline successfully finalized.",
      data: confirmation,
    };
  }
}
