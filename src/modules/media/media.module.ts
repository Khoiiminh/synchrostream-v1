import { InfrastructureModule } from "@/shared/infrastructure/infrastructure.module.js";
import { Module } from "@nestjs/common";
import { MediaController } from "./media.controller.js";
import { MediaService } from "./media.service.js";

@Module({
    imports: [InfrastructureModule],
    controllers: [MediaController],
    exports: [MediaService],
    providers: [MediaService],
})
export class MediaModule {}