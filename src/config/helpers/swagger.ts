import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export interface SwaggerSetupOptions {
    title:        string;
    description:  string;
    version?:     string;
    path?:        string;
}

export function setupSwagger(app: INestApplication, options: SwaggerSetupOptions): void {
    const { title, description, version = '1.0', path = 'api/docs' } = options;

    const config = new DocumentBuilder()
        .setTitle(title)
        .setDescription(description)
        .setVersion(version)
        .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
        .build();

    SwaggerModule.setup(path, app, SwaggerModule.createDocument(app, config));
}
