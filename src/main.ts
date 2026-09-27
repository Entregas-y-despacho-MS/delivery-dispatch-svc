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
            description: [
                'Delivery / dispatch microservice of the ERP.',
                '',
                '**Authenticating.** `POST /auth/login` returns an access token (15 min) and a refresh token (7 days). Click **Authorize** and paste the access token; renew it with `POST /auth/refresh`. The token is checked against the database on every request: a deactivated or deleted user, a changed role or a changed password takes effect immediately (401 `INVALID_TOKEN`).',
                '',
                '**Must change password.** When login answers `mustChangePassword: true`, every endpoint except `PATCH /auth/change-password` and `POST /auth/logout` answers 403 `PASSWORD_CHANGE_REQUIRED` until the password is changed.',
                '',
                '**Errors.** Every error is `{ statusCode, error, message, path, timestamp }`. `error` is a stable code (`SERVICE_LEVEL_IN_USE`, ...) you can branch on; validation errors (400) have `error: "Bad Request"` and `message` as a list, one entry per invalid field.',
                '',
                '**Common statuses.** 401 missing/invalid token · 403 the role cannot do this · 404 not found · 409 conflict (duplicate name/code, or in use) · 429 rate limit (stricter on `change-password` and the 2FA endpoints).',
                '',
                '**Realtime (WebSocket) — not part of this REST document, connect separately.** OpenAPI/Swagger only describes HTTP; this section is the reference for it.',
                '',
                '- **Connect to** `{server}/{WEBSOCKET_NAMESPACE}` (Socket.IO, default namespace `app` — e.g. `wss://.../app`), sending the same access token used here: `auth: { token }` in the handshake, or an `Authorization: Bearer` header. No valid token → disconnected immediately.',
                '- **`dispatch.location.updated`** — pushed live whenever `POST /tracking/locations` saves a new position (RF-U11). Payload: `{ dispatchId, latitude, longitude, recordedAt }` — same shape as one entry of that endpoint\'s request body. Only received by connections whose role is `admin`, `coordinator`, `supervisor` or `root` (auto-joined to the `dispatch-board` room on connect) — a `driver` connection would never receive it. There is no other channel yet; a new one is documented here when it exists.',
                '- The driver\'s app never connects to this socket to report its own position — that is always the plain REST endpoint above (`POST /tracking/locations`), so it works the same online or replaying a buffered offline batch.',
            ].join('\n'),
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
