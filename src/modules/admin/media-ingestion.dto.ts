import { IsNotEmpty, IsString, MaxLength } from "class-validator";

export class InitiateUploadDto {
    @IsString()
    @IsNotEmpty()
    @MaxLength(255)
    title!: string;

    @IsString()
    @IsNotEmpty()
    @MaxLength(100)
    genre!: string;

    @IsString()
    @IsNotEmpty()
    description!: string;
}

export class UploadPartDto {
    @IsString()
    @IsNotEmpty()
    movieId!: string;

    @IsString()
    @IsNotEmpty()
    uploadId!: string;

    @IsString()
    @IsNotEmpty()
    partNumber!: string;
}

export class CompleteUploadDto {
    @IsString()
    @IsNotEmpty()
    movieId!: string;

    @IsString()
    @IsNotEmpty()
    uploadId!: string;

    @IsNotEmpty()
    parts!: Array<{PartNumber: number, ETag: string}>
}