import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Injectable,
    Logger,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Observable } from "rxjs";
import { ROLES_KEY } from "../decorators/roles.decorator.js";
import type { AuthenticatedRequest } from "../auth.types.js";

@Injectable()
export class RolesGuard implements CanActivate {
    private readonly logger = new Logger(RolesGuard.name);
    constructor(private reflector: Reflector) {}

    /**
     *  This is the core method of Guard. It determines
     * whether a specific request is allowed to proceed to the route handler based on
     * conditions like authentication, roles, or permission.
     *
     *  The method receives an `ExecutionContext` object as an argument, providing access to
     * details about the current request, response, and the specific controller/handler being invoked.
     */
    canActivate(
        context: ExecutionContext,
    ): boolean | Promise<boolean> | Observable<boolean> {
        this.logger.verbose({ message: "Checking route role requirements" });

        /**
         *      `Reflector`: is a core utility helper provided by NestJS. It is injected here because
         * the guard needs it to extract the metadata which is saved earlier using @Roles()
         */
        const requiredRoles = this.reflector.getAllAndOverride<string[]>(
            ROLES_KEY,
            [
                context.getHandler(), // check the method first
                context.getClass(), // Check the controller class second
            ],
        );

        if (!requiredRoles) {
            this.logger.verbose({ message: "Route has no role requirement" });
            return true;
        }

        // Extract the standard HTTP request object from NestJS's generic execution context.
        /**
         *  `context`: an instance of `ExecutionContext`, which contains details about the current execution pipeline.
         *
         *  `.switchToHttp()`: a helper method that switches the context to the HTTP protocol
         *      - NestJS is platform-agnostic. The same guard could theoretically run in a microservice (RPC)
         *        or a WebSockets gateway.
         *      - This method explicitly tells NestJS you are handling a standard web request.
         *  `.getRequest()`: This pulls out the underlying platform request object (either from
         *  Express or Fastify, depending on NestJS setup)
         *
         * For WebSockets: context.switchToWs().getClient()
         * For Microservices (gRPC/RabbitMQ): context.switchToRpc().getData()
         */
        const { user } = context
            .switchToHttp()
            .getRequest<Partial<AuthenticatedRequest>>();
        if (!user) {
            this.logger.warn({
                message: "Access denied: no authenticated user",
            });
            throw new ForbiddenException(
                `Access Denied: Missing Authentication Context`,
            );
        }

        if (!user.role) {
            this.logger.warn({
                message: "Access denied: user has no role",
                userId: user.id,
            });
            throw new ForbiddenException(`Access Denied: User role is missing`);
        }

        const hasRole = requiredRoles.includes(user.role);
        if (!hasRole) {
            this.logger.warn({
                message: "Access denied: role not permitted",
                userId: user.id,
                role: user.role,
                requiredRoles,
            });
            throw new ForbiddenException(
                `Access Denied: Requires role [${requiredRoles.join(", ")}]`,
            );
        }

        this.logger.verbose({
            message: "Access granted",
            userId: user.id,
            role: user.role,
        });
        return true;
    }
}
