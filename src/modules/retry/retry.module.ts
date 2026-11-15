import { Module } from "@nestjs/common";
import { RedisRetryHelper } from "./redis-retry.helper.js";

@Module({
    providers: [
        RedisRetryHelper,
    ],

    exports: [
        RedisRetryHelper,
    ]
})
export class RetryModule {}