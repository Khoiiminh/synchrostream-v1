import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  Logger,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcrypt";
import { RedisProvider } from "src/shared/infrastructure/cache/redis.provider.js";
import { PostgresProvider } from "src/shared/infrastructure/database/postgres.provider.js";
import { LoginDto, RegisterDto } from "./auth.dto.js";
import { RedisBlacklistProvider } from "@/shared/infrastructure/cache/redis-blacklist.provider.js";

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly pg: PostgresProvider,
    private readonly jwtService: JwtService,
    private readonly redis: RedisProvider,
    private readonly blacklist: RedisBlacklistProvider,
  ) {}

  async register(dto: RegisterDto) {
    this.logger.log(`Attempting to register user: ${dto.email}`);

    const existing = await this.pg.query(
      "SELECT id FROM users WHERE email = $1 OR username = $2",
      [dto.email, dto.username],
    );

    if (existing.length > 0) {
      this.logger.warn(`Registration failed: Account already exists for ${dto.email}`);
      throw new ConflictException("Account already exists");
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);

    const [newUser] = await this.pg.query<{ id: string }>(
      "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id",
      [dto.username, dto.email, passwordHash],
    );

    this.logger.log(`User successfully created with ID: ${newUser.id}`);
    return { message: "Success: Account Created", userId: newUser.id };
  }

  async login(dto: LoginDto) {
    this.logger.log(`Login attempt for email: ${dto.email}`);

    const [user] = await this.pg.query<any>(
      "SELECT id, username, email, password_hash, role FROM users WHERE email = $1",
      [dto.email],
    );

    if (!user || !(await bcrypt.compare(dto.password, user.password_hash))) {
      this.logger.warn(`Failed login attempt for email: ${dto.email}`);
      throw new UnauthorizedException("Invalid Credentials");
    }

    const payload = { sub: user.id, username: user.username, role: user.role };

    const expiresIn = user.role === "ADMIN" ? "1h" : "7d";
    const token = this.jwtService.sign(payload, { expiresIn });

    await this.redis["client"].set(
      `user:${user.id}:session`,
      token,
      "EX",
      86400,
    );

    this.logger.log(`User ${user.id} logged in successfully. Role: ${user.role}`);
    
    return { 
      user: {
        id: user.id,
        username: user.username,
        email: user.username,
        role: user.role
      },
      access_token: token 
    };
  }

  async logout(token: string) {
    this.logger.log('Logout request initiated')
    const decoded = this.jwtService.decode(token) as { exp: number, sub: string };

    if (!decoded) {
      this.logger.warn('Logout attempted with an unparsable or malformed token');
      return {
        message: 'Logout processed'   // Avoid crashing if token is unparsable
      };
    }

    const now = Math.floor(Date.now() / 1000);
    const ttl = decoded.exp - now;

    if (ttl > 0) {
      await this.blacklist.add({ token, ttl });
      this.logger.log(`Token blacklisted for user: ${decoded.sub}`);
    }

    const userId = (decoded as any).sub;
    await this.redis['client'].del(`user:${userId}:session`);

    this.logger.debug(`Session cleared for user: ${userId}`);
    return {
      message: "Logged out and token revoked"
    }
  }
}
