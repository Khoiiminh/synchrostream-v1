import { IsEmail, IsNotEmpty, IsString, MinLength, MaxLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RegisterDto {
    @ApiProperty({
        description: 'The unique nickname for the account profile',
        example: 'john_doe',
        maxLength: 50,
    })
    @IsString()
    @IsNotEmpty()
    @MaxLength(50)
    username!: string;

    @ApiProperty({
        description: 'The valid email address used for communication and logins',
        example: 'john.doe@example.com',
        maxLength: 100
    })
    @IsEmail()
    @IsNotEmpty()
    @MaxLength(100)
    email!: string;

    @ApiProperty({
        description: 'Account secure password string (min 8 characters).',
        example: 'SuperSecretP@ss123',
        minLength: 8,
    })
    @IsString()
    @IsNotEmpty()
    @MinLength(8)
    password!: string;
}

export class LoginDto {
    @ApiProperty({
        description: 'The registered user email address.',
        example: 'john.doe@example.com',
        maxLength: 100
    })
    @IsEmail()
    @IsNotEmpty()
    @MaxLength(100)
    email!: string;
    
    @ApiProperty({
        description: 'The corresponding profile password account string.',
        example: 'SuperSecretP@ss123',
        minLength: 8,
    })
    @IsString()
    @IsNotEmpty()
    @MinLength(8)
    password!: string;
}