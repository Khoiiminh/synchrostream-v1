import {
    ArrayMaxSize,
    IsArray,
    IsNotEmpty,
    IsObject,
    IsOptional,
    IsString,
    Matches,
    MaxLength,
} from "class-validator";

/** Run, scenario and participant identifiers become path segments, so keep them filename-safe. */
export const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * One batch of synchronization measurements from one client.
 *
 * `records` are kept as plain objects (samples and events share this
 * channel); the service stamps them with server-side identity and receive
 * time before persisting them.
 */
export class SyncMetricsBatchDto {
    @IsString()
    @IsNotEmpty()
    @Matches(SAFE_ID_PATTERN)
    runId!: string;

    @IsOptional()
    @IsString()
    @Matches(SAFE_ID_PATTERN)
    scenario?: string;

    @IsOptional()
    @IsString()
    @MaxLength(80)
    roomId?: string;

    /** Distinguishes several tabs of the same user within a run. */
    @IsString()
    @Matches(SAFE_ID_PATTERN)
    clientSessionId!: string;

    @IsOptional()
    @IsObject()
    client?: Record<string, unknown>;

    @IsArray()
    @ArrayMaxSize(5000)
    @IsObject({ each: true })
    records!: Record<string, unknown>[];
}

export class UpdateSyncRunDto {
    @IsOptional()
    @IsString()
    @MaxLength(5000)
    notes?: string;

    @IsOptional()
    @IsArray()
    @ArrayMaxSize(20)
    @IsString({ each: true })
    @MaxLength(40, { each: true })
    tags?: string[];
}
