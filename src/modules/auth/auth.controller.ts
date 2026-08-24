import { Controller, Post, Body, HttpCode, HttpStatus, UseGuards, Get, Request, Logger, Header } from "@nestjs/common";
import { AuthService } from "./auth.service.js";
import { RegisterDto, LoginDto } from "./auth.dto.js";
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from "./jwt-auth.guard.js";
import type { Request as ExpressRequest } from "express";

@ApiTags('Authentication Engine')
@Controller("auth")
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(private readonly authService: AuthService) {}

  @Post("register")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register a brand new user profile account' })
  @ApiBody({ type: RegisterDto })
  @ApiResponse({
    status: 201,
    description: 'Account successfully initialized and written to database',
    schema: {
      example: {
        success: true,
        message: 'Success: Account Created',
        data: { userId: 'd3b07384-d113-49cd-a5d6-8ee301234567' },
        timestamp: '2026-05-21T15:20:00.000Z',
      }
    }
  })
  @ApiResponse({
    status: 400,
    description: 'Payload validation error (e.g. malformed email syntax or missing password elements).',
    schema: {
      example: {
        success: false,
        message: 'Validation failed',
        data: [
          'email must be a valid email address',
          'password must be longer than or equal to 8 characters'
        ],
        timestamp: '2026-05-21T15:22:14.123Z'
      }
    }
  })
  @ApiResponse({
    status: 409,
    description: 'ConflictException: Email or Username is already occupied.',
    schema: {
      example: {
        success: false,
        message: 'Account already exists',
        data: 'Conflict',
        timestamp: '2026-05-21T15:23:02.456Z'
      }
    }
  })
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post("login")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Authenticate credentials to obtain access tokens' })
  @ApiBody({ type: LoginDto })
  @ApiResponse({
    status: 200,
    description: 'Bearer token issued successfully.',
    schema: {
      example: {
        success: true,
        message: 'Request processed successfully',
        data: { access_token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' },
        timestamp: '2026-05-21T15:21:00.000Z'
      }
    }
  })
  @ApiResponse({
    status: 401,
    description: 'UnauthorizedException: Invalid email credentials or password matching.',
    schema: {
      example: {
        success: false,
        message: 'Invalid Credentials',
        data: 'Unauthorized',
        timestamp: '2026-05-21T15:24:45.789Z'
      }
    }
  })
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @UseGuards(JwtAuthGuard)
  @Get("me")
  @HttpCode(HttpStatus.OK)
  async getProfile(@Request() req: ExpressRequest & { user: { id: string; username: string; role: string } }) {
    // req.user is automatically attached by passport-jwt strategy validate()
    this.logger.log(`User ${req.user.id} (${req.user.role}) is fetching their profile`);
    
    const dbUser = await this.authService.findUserProfileById(req.user.id);
    
    return {
      message: "Profile retrieved successfully from database context",
      data: {
        id: dbUser.id,
        username: dbUser.username,
        email: dbUser.email, // Cleanly forwarded now
        role: dbUser.role
      }
    };
  }

  @UseGuards(JwtAuthGuard)
  @Post("logout")
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ 
    summary: 'Revoke current access token',
    description: 'Blacklist the current JWT in the dedicated Redis engine to prevent future use.' 
  })
  @ApiResponse({
    status: 200,
    description: 'Token successfully invalidated.',
    schema: {
      example: {
        success: true,
        messagge: 'Logged out successfully',
        data: null,
        timestamp: '2026-06-01T13:45:00.000Z'
      }
    }
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized: Missing or already revoked token.',
    schema: {
      example: {
        success: false,
        message: 'This session has been revoked',
        data: 'Unauthorized',
        timestamp: '2026-06-01T13:46:00.000Z'
      }
    }
  })
  async logout(@Request() req: ExpressRequest) {
    const authHeader = req.headers.authorization;
    const token = authHeader?.split(' ')[1];

    if (!token) {
      this.logger.warn('Logout attempt without token in header');
      return {
        message: 'No active session'
      };
    }

    return this.authService.logout(token);
  }
}
