import { maskEmail } from "../../common/logging/logger.js";
import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  Logger,
  NotFoundException,
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
    this.logger.debug({ message: 'Registration attempt', email: maskEmail(dto.email) });

    const existing = await this.pg.query(
      "SELECT id FROM users WHERE email = $1 OR username = $2",
      [dto.email, dto.username],
    );

    if (existing.rows.length > 0) {
      this.logger.warn({ message: 'Registration rejected: account already exists', email: maskEmail(dto.email) });
      throw new ConflictException("Account already exists");
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);

    const newUser = await this.pg.query<{ id: string }>(
      "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id",
      [dto.username, dto.email, passwordHash],
    );

    this.logger.log({ message: 'User registered', userId: newUser.rows[0].id });
    return { message: "Success: Account Created", userId: newUser.rows[0].id };
  }

  async login(dto: LoginDto) {
    this.logger.debug({ message: 'Login attempt', email: maskEmail(dto.email) });

    const user = await this.pg.query<any>(
      "SELECT id, username, email, password_hash, role FROM users WHERE email = $1",
      [dto.email],
    );

    if (!user || !(await bcrypt.compare(dto.password, user.rows[0].password_hash))) {
      this.logger.warn({ message: 'Login failed: invalid credentials', email: maskEmail(dto.email) });
      throw new UnauthorizedException("Invalid Credentials");
    }

    const payload = { sub: user.rows[0].id, username: user.rows[0].username, role: user.rows[0].role };

    const expiresIn = user.rows[0].role === "ADMIN" ? "1h" : "7d";
    const token = this.jwtService.sign(payload, { expiresIn });

    await this.redis["client"].set(
      `user:${user.rows[0].id}:session`,
      token,
      "EX",
      86400,
    );

    this.logger.log({ message: 'User logged in', userId: user.rows[0].id, role: user.rows[0].role });
    
    return { 
      user: {
        id: user.rows[0].id,
        username: user.rows[0].username,
        email: user.rows[0].email,
        role: user.rows[0].role
      },
      access_token: token 
    };
  }

  async logout(token: string) {
    this.logger.debug({ message: 'Logout requested' })
    const decoded = this.jwtService.decode(token) as { exp: number, sub: string };

    if (!decoded) {
      this.logger.warn({ message: 'Logout rejected: malformed token' });
      return {
        message: 'Logout processed'   // Avoid crashing if token is unparsable
      };
    }

    const now = Math.floor(Date.now() / 1000);
    const ttl = decoded.exp - now;

    if (ttl > 0) {
      await this.blacklist.add({ token, ttl });
      this.logger.log({ message: 'User logged out; token blacklisted', userId: decoded.sub });
    }

    const userId = (decoded as any).sub;
    await this.redis['client'].del(`user:${userId}:session`);

    this.logger.debug({ message: 'Session cleared', userId });
    return {
      message: "Logged out and token revoked"
    }
  }

  async findUserProfileById(userId: string) {
    const query = `
      SELECT 
        id, 
        username, 
        email, 
        role 
      FROM public.users 
      WHERE id = $1;
    `;

    const user = await this.pg.query<any>(query, [userId]);

    if (!user || user.rows.length === 0) {
      this.logger.warn({ message: 'Profile lookup failed: user not found', userId });
      throw new NotFoundException('The requested user session profile could not be located.');
    }

    return user.rows[0];
  }
}
