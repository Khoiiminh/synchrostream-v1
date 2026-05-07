import {
  Injectable,
  UnauthorizedException,
  ConflictException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcrypt";
import { RedisProvider } from "src/shared/infrastructure/cache/redis.provider.js";
import { PostgresProvider } from "src/shared/infrastructure/database/postgres.provider.js";
import { LoginDto, RegisterDto } from "./auth.dto.js";

@Injectable()
export class AuthService {
  constructor(
    private readonly pg: PostgresProvider,
    private readonly jwtService: JwtService,
    private readonly redis: RedisProvider,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.pg.query(
      "SELECT id FROM users WHERE email = $1 OR username = $2",
      [dto.email, dto.username],
    );

    if (existing.length > 0) {
      throw new ConflictException("Account already exists");
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);

    const [newUser] = await this.pg.query<{ id: string }>(
      "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id",
      [dto.username, dto.email, passwordHash],
    );

    return { message: "Success: Account Created", userId: newUser.id };
  }

  async login(dto: LoginDto) {
    const [user] = await this.pg.query<any>(
      "SELECT id, username, email, password_hash, role FROM users WHERE email = $1",
      [dto.email],
    );

    if (!user || !(await bcrypt.compare(dto.password, user.password_hash))) {
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

    return { access_token: token };
  }
}
