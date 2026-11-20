/*
 * Who is calling: the token claims and the request/socket shapes the guards
 * attach. Shared by every module; the users table stays owned by auth.
 */
import type { Request } from "express";
import type { DefaultEventsMap, Socket } from "socket.io";

/** Claims signed into access tokens by AuthService.login(). */
export interface JwtPayload {
    sub: string;
    username: string;
    role: string;
    iat?: number;
    exp?: number;
}

/** The user object JwtStrategy.validate() attaches to `request.user`. */
export interface AuthenticatedUser {
    id: string;
    username: string;
    role: string;
}

/** An Express request that has passed JwtAuthGuard. */
export interface AuthenticatedRequest extends Request {
    user: AuthenticatedUser;
}

/** Data WsJwtGuard attaches to `socket.data` after verifying the token. */
export interface AuthenticatedSocketData {
    user?: AuthenticatedUser & { email: string };
}

/** A Socket.IO socket whose `data` is typed; `user` is set once WsJwtGuard passes. */
export type AuthenticatedSocket = Socket<
    DefaultEventsMap,
    DefaultEventsMap,
    DefaultEventsMap,
    AuthenticatedSocketData
>;
