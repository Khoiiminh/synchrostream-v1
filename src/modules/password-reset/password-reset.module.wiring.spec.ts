import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { PasswordResetModule } from "./password-reset.module.js";
import { PasswordService } from "./password-reset.service.js";
import { PasswordResetAccounts } from "../auth/queries/password-reset-accounts.js";

jest.mock("../../common/logging/logger.js", () => ({
    maskEmail: (email: string) => email,
}));

it("PasswordService reaches users only through auth's published contract", async () => {
    // compile() runs no lifecycle hooks, so nothing connects or reads OAuth config.
    // JwtStrategy reads its secret at construction; a dummy, never used.
    process.env.JWT_SECRET ??= "wiring-test-secret";
    const moduleRef = await Test.createTestingModule({
        imports: [
            ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
            PasswordResetModule,
        ],
    }).compile();

    const service = moduleRef.get<PasswordService, Record<string, unknown>>(
        PasswordService,
    );
    expect(service.passwordResetRepository).toBeInstanceOf(
        PasswordResetAccounts,
    );
    expect(service.passwordResetRepository).toBe(
        moduleRef.get(PasswordResetAccounts, { strict: false }),
    );
});
