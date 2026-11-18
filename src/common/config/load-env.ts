import { existsSync } from "node:fs";

/**
 * The env file ConfigModule reads; shared so both loaders use the same file.
 */
export const ENV_FILE_PATH = ".env.development";

/**
 * Loads the env file into process.env as a side effect of being imported.
 *
 * main.ts imports this module FIRST. ES modules evaluate in import order, so
 * this runs before any module that reads process.env at load time (notably
 * common/logging/logger.ts, which reads NODE_ENV / LOG_LEVEL / LOG_FORMAT when
 * it creates the root logger). Without it those values are only applied later
 * by ConfigModule and the logger never sees them.
 *
 * Like ConfigModule, variables already set in the real environment win.
 */
if (existsSync(ENV_FILE_PATH)) {
    process.loadEnvFile(ENV_FILE_PATH);
}
