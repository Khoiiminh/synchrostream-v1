import { IsNotEmpty, IsUUID } from "class-validator";

export class StartTranscodeDto {
    @IsUUID()
    @IsNotEmpty()
    movieId!: string;
}