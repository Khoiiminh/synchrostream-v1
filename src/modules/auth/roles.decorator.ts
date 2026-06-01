import { SetMetadata } from "@nestjs/common";

export const ROLES_KEY = 'roles';

/**
 *      This defines a custom decorator function named @Roles().
 * It uses the JavsScript rest parameter syntax(`...roles`) to accept an array of
 * strings (e.g., @Roles('admin', 'user'))
 * 
 *      `SetMetatdata()`: is built-in NestJS function. It takes the key(`roles`) and the values are passed in, then attaches
 * directly to the controller class or route handler method so the Guard can read them later.
 */
export const Roles = ( ...roles: string[] ) => SetMetadata(ROLES_KEY, roles);