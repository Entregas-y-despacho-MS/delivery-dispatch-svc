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

    CACHE_ADAPTER: Joi.string().valid('redis', 'memory').default('redis'),
    REDIS_HOST:    Joi.string().default('localhost'),
    REDIS_PORT:    Joi.number().port().default(6379),

    // -- Plugin: messaging (Google Cloud Pub/Sub) -------------------------------
    // Production must select Pub/Sub explicitly; local development defaults to the emulator configuration in .env.example.
    /* oxlint-disable unicorn/no-thenable -- `then`/`otherwise` are Joi's own conditional keys */
    MESSAGING_ADAPTER: Joi.string().when('NODE_ENV', {
        is:        EnvironmentEnum.PRODUCTION,
        then:      Joi.string().valid('pubsub').required(),
        otherwise: Joi.string().valid('pubsub', 'memory').default('pubsub'),
    }),
    /* oxlint-enable unicorn/no-thenable */
    // Default only for local work: in production without an emulator the project must be explicit, or
    // the service would talk to the real Pub/Sub with the project name of the emulator.
    /* oxlint-disable unicorn/no-thenable -- `then`/`otherwise` are Joi's own conditional keys */
    PUBSUB_PROJECT_ID:          Joi.string().when('NODE_ENV', {
        is:        EnvironmentEnum.PRODUCTION,
        then:      Joi.when('PUBSUB_EMULATOR_HOST', {
            is:        Joi.string().min(1).required(),
            then:      Joi.string().default('delivery-dispatch-local'),
            otherwise: Joi.string().required(),
        }),
        otherwise: Joi.string().default('delivery-dispatch-local'),
    }),
    // host:port of the emulator; leave empty to use real Pub/Sub with application default credentials.
    PUBSUB_EMULATOR_HOST:       Joi.string().allow('').optional(),
    // Subscription of this service on every incoming topic: <topic>.<suffix>.
    PUBSUB_SUBSCRIPTION_SUFFIX: Joi.string().default('dispatch-svc'),
    // Folder with envelope.schema.json and schemas/*.schema.json, relative to the working directory.
    MESSAGING_CONTRACTS_DIR:    Joi.string().default('contracts/messages'),

    // -- Outbox publisher (outbound_messages) ------------------------------------
    // 0 disables the timer. Fast retries after 1 s, 2 s and 4 s, then one every OUTBOX_SLOW_RETRY_SECONDS until the
    // message is OUTBOX_GIVE_UP_AFTER_MINUTES old and is left in `failed` (see outbox-publisher.config.ts).
    OUTBOX_POLL_INTERVAL_MS:    Joi.number().integer().min(0).default(2000),
    OUTBOX_SLOW_RETRY_SECONDS:  Joi.number().integer().min(1).default(60),
    OUTBOX_GIVE_UP_AFTER_MINUTES: Joi.number().integer().min(1).default(240),
    OUTBOX_BATCH_SIZE:          Joi.number().integer().min(1).default(20),
    OUTBOX_LEASE_SECONDS:       Joi.number().integer().min(1).default(60),
    OUTBOX_PUBLISH_TIMEOUT_MS:  Joi.number().integer().min(1).default(10000),

    // -- Scheduler (app/scheduler) --------------------------------------------
    // false turns the minute tick off (e2e, or an instance that must not run tasks); manual triggers still work.
    SCHEDULER_ENABLED:          Joi.boolean().default(true),

    // -- Auth (JWT) -----------------------------------------------------------
    ACTIVE_JWT:              Joi.boolean().default(true),
    JWT_SECRET:              Joi.string().required(),
    JWT_TIME_EXPIRE:         Joi.string().default('15m'),
    JWT_REFRESH_SECRET:      Joi.string().required(),
    JWT_REFRESH_TIME_EXPIRE: Joi.string().default('7d'),

    // -- Plugin: mailer -------------------------------------------------------
    MAILER_TRANSPORT: Joi.string().valid('smtp', 'api', 'log').default('smtp'),
    MAILER_BOUNCE_EMAIL: Joi.string().email().default('bounce@example.test'),
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
    // Must not exceed the instance's --max-table-size (default 100, measured 2026-10-14). Bigger matrices are split.
    OSRM_TABLE_MAX_COORDINATES: Joi.number().integer().min(2).default(100),
    // A request that takes longer is aborted and answered as 503 OSRM_UNAVAILABLE.
    OSRM_TIMEOUT_MS: Joi.number().integer().min(100).default(5000),

    // -- Rate limiting (@nestjs/throttler) ---------------------------------------
    THROTTLE_TTL_MS: Joi.number().default(60000),
    THROTTLE_LIMIT:  Joi.number().default(100),
    // change-password and the 2FA endpoints (they verify a secret of a logged-in user)
    THROTTLE_SENSITIVE_LIMIT: Joi.number().default(10),

});
