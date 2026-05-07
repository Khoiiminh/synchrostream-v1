import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { ValidationPipe } from '@nestjs/common';
import { TransformationInterceptor } from './common/interceptors/transformation.interceptor.js';

async function bootstrap() {
    const app = await NestFactory.create(AppModule);
    
    app.useGlobalInterceptors(new TransformationInterceptor());

    app.setGlobalPrefix('v1');

    // Ensure ValidationPipe is active for the Auth DTOs
    /**
     * a method used to apply validation or transformation logic to 
     * every single route handler in your entire application
     */
    app.useGlobalPipes(new ValidationPipe({
        whitelist: true,                // Strips properties that don't have decorators in the DTO
        forbidNonWhitelisted: true,     // Throws an error if non-whitelisted properties are present
        transform: true                 // Automatically transforms payloads to match DTO types
    }));

    await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
