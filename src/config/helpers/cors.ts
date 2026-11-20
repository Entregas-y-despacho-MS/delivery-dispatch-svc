import { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';
import { CORRELATION_HEADER } from '../../modules/audit/admin-audit-events/middleware/correlation-id.middleware.js';

// Response headers a browser client may read: the correlation id lets the web app point at the exact request.
const EXPOSED_HEADERS = [CORRELATION_HEADER];

// Accepts '*', a single origin, or a comma-separated list of origins.
export function getCorsOptions(allowedOrigins: string): CorsOptions {
    if (allowedOrigins === '*') {
        return { origin: true, methods: 'GET,HEAD,PUT,PATCH,POST,DELETE', credentials: true, exposedHeaders: EXPOSED_HEADERS };
    }

    const origins = allowedOrigins.split(',').map(o => o.trim());
    return {
        origin: (origin, callback) => {
            if (!origin || origins.includes(origin)) {
                callback(null, true);
            } else {
                callback(new Error(`Origin "${origin}" not allowed by CORS`), false);
            }
        },
        methods:        'GET,HEAD,PUT,PATCH,POST,DELETE',
        credentials:    true,
        exposedHeaders: EXPOSED_HEADERS,
    };
}
