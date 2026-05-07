import { IsEmail, IsNotEmpty, IsString, MinLength } from 'class-validator';

export class RequestResetDto {
    @IsEmail()
    @IsString()
    email!: string;
}

export class ResetPasswordDto {
    @IsString()
    @IsNotEmpty()
    token!: string;

    @IsString()
    @IsNotEmpty()
    @MinLength(8)
    newPassword!: string;
}