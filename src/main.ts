import 'dotenv/config';

import { types } from 'pg';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { AppConfig } from './config/services/app.config.js';
import { getEnvSettings } from './config/helpers/environment.js';
import { getCorsOptions } from './config/helpers/cors.js';
import { setupSwagger } from './config/helpers/swagger.js';
import { logServerStatus } from './config/helpers/logger.js';
import { HttpExceptionFilter } from './shared/filters/index.js';
import { JwtConfig } from './app/auth/config/jwt.config.js';
import { DatabaseConfig } from './database/config/database.config.js';

async function bootstrap() {
    const { logger, swagger } = getEnvSettings(process.env.NODE_ENV);

    // BigInt / bigserial (OID 20) arrives as string from pg — cast for auto-increment IDs.
    types.setTypeParser(20, Number);

    const app = await NestFactory.create(AppModule, { logger });
    const cfg = app.get(AppConfig);

    app.setGlobalPrefix(cfg.apiPrefix);

    if (swagger) {
        setupSwagger(app, {
            title:       'delivery-dispatch-svc',
            description: 'API Documentation',
            version:     '1.0',
            path:        'api/docs',
        });
    }

    app.enableCors(getCorsOptions(cfg.corsOrigins));

    app.useGlobalPipes(new ValidationPipe({
        transform:            true,
        whitelist:            true,
        forbidNonWhitelisted: true,
        transformOptions:     { enableImplicitConversion: false },
    }));

    app.useGlobalFilters(new HttpExceptionFilter());

    await app.listen(cfg.port);

    const jwtCfg = app.get(JwtConfig,      { strict: false });
    const dbCfg  = app.get(DatabaseConfig, { strict: false });

    logServerStatus(cfg, 'delivery-dispatch-svc', {
        swagger:   swagger,
        docsPath:  'api/docs',
        cors:      cfg.corsOrigins,
        logLevels: logger,
        jwtActive: jwtCfg.isActive,
        dbLogs:    dbCfg.logging,
        database:  `${dbCfg.host}:${dbCfg.port}/${dbCfg.database}`,
    });
}
bootstrap();
