import { Injectable } from "@nestjs/common";
import * as bcrypt from "bcrypt";
import type { PasswordHasher } from "../../application/ports/collaborators.port.js";

/** Same cost factor as user passwords (auth and password-reset). */
export const ROOM_PASSWORD_BCRYPT_ROUNDS = 10;

/** bcrypt adapter of the PasswordHasher port. */
@Injectable()
export class BcryptPasswordHasher implements PasswordHasher {
    hash(plain: string): Promise<string> {
        return bcrypt.hash(plain, ROOM_PASSWORD_BCRYPT_ROUNDS);
    }

    compare(plain: string, hash: string): Promise<boolean> {
        return bcrypt.compare(plain, hash);
    }
}
