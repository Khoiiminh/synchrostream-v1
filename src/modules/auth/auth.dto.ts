import { IsEmail, IsNotEmpty, IsString, MinLength, MaxLength, Matches } from 'class-validator';

export class RegisterDto {
    @IsString()
    @IsNotEmpty()
    @MaxLength(50)
    username!: string;

    @IsEmail()
    @IsNotEmpty()
    @MaxLength(100)
    email!: string;

    @IsString()
    @IsNotEmpty()
    @MinLength(8)
    password!: string;
}

export class LoginDto {
    @IsEmail()
    @IsNotEmpty()
    @MaxLength(100)
    email!: string;
    
    @IsString()
    @IsNotEmpty()
    @MinLength(8)
    password!: string;
}