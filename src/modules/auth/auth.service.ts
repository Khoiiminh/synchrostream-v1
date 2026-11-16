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
import { LoginDto, RegisterDto } from "./auth.dto.js";
import { AuthRepository } from "./auth.repository.js";
import type { JwtPayload } from "./auth.types.js";
import { RedisBlacklistProvider } from "@/shared/infrastructure/cache/redis-blacklist.provider.js";

@Injectable()
export class AuthService {
    private readonly logger = new Logger(AuthService.name);

    constructor(
        private readonly authRepository: AuthRepository,
        private readonly jwtService: JwtService,
        private readonly redis: RedisProvider,
        private readonly blacklist: RedisBlacklistProvider,
    ) {}

    async register(dto: RegisterDto) {
        this.logger.debug({
            message: "Registration attempt",
            email: maskEmail(dto.email),
        });

        if (
            await this.authRepository.existsByEmailOrUsername(
                dto.email,
                dto.username,
            )
        ) {
            this.logger.warn({
                message: "Registration rejected: account already exists",
                email: maskEmail(dto.email),
            });
            throw new ConflictException("Account already exists");
        }

        const passwordHash = await bcrypt.hash(dto.password, 10);

        const userId = await this.authRepository.createUser(
            dto.username,
            dto.email,
            passwordHash,
        );

        this.logger.log({
            message: "User registered",
            userId: userId,
        });
        return {
            message: "Success: Account Created",
            userId: userId,
        };
    }

    async login(dto: LoginDto) {
        this.logger.debug({
            message: "Login attempt",
            email: maskEmail(dto.email),
        });

        // Unknown email and wrong password get the same 401 so the response
        // doesn't reveal which accounts exist.
        const user = await this.authRepository.findCredentialsByEmail(
            dto.email,
        );
        if (
            !user ||
            !(await bcrypt.compare(dto.password, user.password_hash))
        ) {
            this.logger.warn({
                message: "Login failed: invalid credentials",
                email: maskEmail(dto.email),
            });
            throw new UnauthorizedException("Invalid Credentials");
        }

        const payload: JwtPayload = {
            sub: user.id,
            username: user.username,
            role: user.role,
        };

        const expiresIn = user.role === "ADMIN" ? "1h" : "7d";
        const token = this.jwtService.sign(payload, { expiresIn });

        await this.redis["client"].set(
            `user:${user.id}:session`,
            token,
            "EX",
            86400,
        );

        this.logger.log({
            message: "User logged in",
            userId: user.id,
            role: user.role,
        });

        return {
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                role: user.role,
            },
            access_token: token,
        };
    }

    async logout(token: string) {
        this.logger.debug({ message: "Logout requested" });
        const decoded = this.jwtService.decode<JwtPayload | null>(token);

        if (!decoded) {
            this.logger.warn({ message: "Logout rejected: malformed token" });
            return {
                message: "Logout processed", // Avoid crashing if token is unparsable
            };
        }

        const now = Math.floor(Date.now() / 1000);
        const ttl = (decoded.exp ?? now) - now;

        if (ttl > 0) {
            await this.blacklist.add({ token, ttl });
            this.logger.log({
                message: "User logged out; token blacklisted",
                userId: decoded.sub,
            });
        }

        const userId = decoded.sub;
        await this.redis["client"].del(`user:${userId}:session`);

        this.logger.debug({ message: "Session cleared", userId });
        return {
            message: "Logged out and token revoked",
        };
    }

    async findUserProfileById(userId: string) {
        const user = await this.authRepository.findProfileById(userId);

        if (!user) {
            this.logger.warn({
                message: "Profile lookup failed: user not found",
                userId,
            });
            throw new NotFoundException(
                "The requested user session profile could not be located.",
            );
        }

        return user;
    }
}
