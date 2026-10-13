import { describe, expect, it } from 'vitest';
import { envValidation } from './env.validation.js';

const requiredEnvironment = {
    DB_TYPE: 'postgres',
    DB_HOST: 'localhost',
    DB_PORT: 5432,
    DB_USER: 'postgres',
    DB_PASSWORD: 'test-password',
    DB_NAME: 'delivery_dispatch_test',
    JWT_SECRET: 'test-jwt-secret',
    JWT_REFRESH_SECRET: 'test-refresh-secret',
};

describe('messaging environment defaults', () => {
    it('uses Pub/Sub for local development without adapter configuration', () => {
        const { error, value } = envValidation.validate(requiredEnvironment);

        expect(error).toBeUndefined();
        expect(value.MESSAGING_ADAPTER).toBe('pubsub');
    });

    it('requires production to explicitly select Pub/Sub', () => {
        const { error } = envValidation.validate({
            ...requiredEnvironment,
            NODE_ENV: 'production',
            PUBSUB_PROJECT_ID: 'delivery-dispatch-production',
        });

        expect(error?.message).toContain('MESSAGING_ADAPTER');
    });

    it('rejects the in-memory adapter in production', () => {
        const { error } = envValidation.validate({
            ...requiredEnvironment,
            NODE_ENV: 'production',
            MESSAGING_ADAPTER: 'memory',
            PUBSUB_PROJECT_ID: 'delivery-dispatch-production',
        });

        expect(error?.message).toContain('MESSAGING_ADAPTER');
    });
});
