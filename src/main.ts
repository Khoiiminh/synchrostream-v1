import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { ValidationPipe } from '@nestjs/common';
import { TransformationInterceptor } from './common/interceptors/transformation.interceptor.js';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { GlobalExceptionFilter } from './common/interceptors/http-exception.filter.js';
import cookieParser from 'cookie-parser';

async function bootstrap() {
    const app = await NestFactory.create(AppModule);

    // Frontend origins
    const allowedOrigins = [
        'http://localhost:3000',
        'http://192.168.1.4:3000'
    ];

    app.enableCors({
        origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
            if (!origin || allowedOrigins.includes(origin)) {
                callback(null, true);
            } else {
                callback(new Error('Not allowed by CORS'));
            }
        },
        methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
        credentials: true,      // Allow cookies
    });
    
    app.use(cookieParser())
    app.useGlobalInterceptors(new TransformationInterceptor());
    app.useGlobalFilters(new GlobalExceptionFilter());
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

    const config = new DocumentBuilder()
        .setTitle('Application API Engine')
        .setDescription('API documentation for the backend authentication and infrastructure core.')
        .setVersion('1.0')
        .addBearerAuth(
            {
                type: 'http',
                scheme: 'bearer',
                bearerFormat: 'JWT',
                name: 'JWT',
                description: 'Enter your JWT token to access protected endpoints',
                in: 'header'
            },
            'JWT-auth',
        )
        .build();

    const document = SwaggerModule.createDocument(app, config);

    SwaggerModule.setup('v1/docs', app, document);

    await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
