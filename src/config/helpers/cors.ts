import { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

// Accepts '*', a single origin, or a comma-separated list of origins.
export function getCorsOptions(allowedOrigins: string): CorsOptions {
    if (allowedOrigins === '*') {
        return { origin: true, methods: 'GET,HEAD,PUT,PATCH,POST,DELETE', credentials: true };
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
        methods:     'GET,HEAD,PUT,PATCH,POST,DELETE',
        credentials: true,
    };
}
