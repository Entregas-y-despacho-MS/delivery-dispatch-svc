import Joi from 'joi';
import { EnvironmentEnum } from '../shared/enums/index.js';

export const envValidation = Joi.object({

    // -- Server ---------------------------------------------------------------
    NODE_ENV:     Joi.string().valid(...Object.values(EnvironmentEnum)).default(EnvironmentEnum.DEVELOPMENT),
    PORT:         Joi.number().default(3000),
    API_PREFIX:   Joi.string().default('api'),
    CORS_ORIGINS: Joi.string().default('*'),

    // -- Database -------------------------------------------------------------
    DB_TYPE:     Joi.string().required(),
    DB_HOST:     Joi.string().required(),
    DB_PORT:     Joi.number().required(),
    DB_USER:     Joi.string().required(),
    DB_PASSWORD: Joi.string().required(),
    DB_NAME:     Joi.string().required(),
    DB_LOGS:     Joi.boolean().default(false),

    // -- Auth (JWT) -----------------------------------------------------------
    ACTIVE_JWT:              Joi.boolean().default(true),
    JWT_SECRET:              Joi.string().required(),
    JWT_TIME_EXPIRE:         Joi.string().default('15m'),
    JWT_REFRESH_SECRET:      Joi.string().required(),
    JWT_REFRESH_TIME_EXPIRE: Joi.string().default('7d'),

    // -- Plugin: mailer -------------------------------------------------------
    MAILER_TRANSPORT: Joi.string().valid('smtp', 'api').default('smtp'),
    SMTP_HOST:        Joi.string().optional(),
    SMTP_PORT:        Joi.number().default(587),
    SMTP_USER:        Joi.string().optional(),
    SMTP_PASS:        Joi.string().optional(),
    SMTP_FROM:        Joi.string().default('"No Reply" <noreply@example.com>'),
    MAILER_API_URL:   Joi.string().uri().optional(),
    MAILER_API_KEY:   Joi.string().optional(),
    MAILER_FROM:      Joi.string().optional(),

    // -- Plugin: socket -------------------------------------------------------
    WEBSOCKET_NAMESPACE: Joi.string().default('app'),

    // -- Plugin: pdf (Puppeteer) ------------------------------------------------
    // true (default) works both on a bare host and inside Docker without extra capabilities.
    // false only makes sense if the container is granted --cap-add=SYS_ADMIN.
    PUPPETEER_NO_SANDBOX: Joi.boolean().default(true),

    // -- Plugin: storage --------------------------------------------------------
    STORAGE_PROVIDER:      Joi.string().valid('local', 'cloudinary').default('local'),
    UPLOADS_DIR:           Joi.string().default('uploads'),
    PUBLIC_URL:            Joi.string().default('http://localhost:3000'),
    CLOUDINARY_CLOUD_NAME: Joi.string().optional(),
    CLOUDINARY_API_KEY:    Joi.string().optional(),
    CLOUDINARY_API_SECRET: Joi.string().optional(),
    CLOUDINARY_FOLDER:     Joi.string().default('delivery-dispatch'),

    // -- Plugin: push -----------------------------------------------------------
    PUSH_PROVIDER:        Joi.string().valid('expo', 'firebase').default('expo'),
    EXPO_PUSH_API_URL:    Joi.string().uri().default('https://exp.host/--/api/v2/push/send'),
    EXPO_ACCESS_TOKEN:    Joi.string().optional(),
    FIREBASE_PROJECT_ID:  Joi.string().optional(),
    FIREBASE_CLIENT_EMAIL:Joi.string().optional(),
    FIREBASE_PRIVATE_KEY: Joi.string().optional(),

    // -- Plugin: osrm -------------------------------------------------------------
    OSRM_URL: Joi.string().uri().default('http://localhost:5001'),

    // -- Rate limiting (@nestjs/throttler) ---------------------------------------
    THROTTLE_TTL_MS: Joi.number().default(60000),
    THROTTLE_LIMIT:  Joi.number().default(100),

});
