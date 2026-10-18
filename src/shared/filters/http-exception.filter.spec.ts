import { InternalServerErrorException, Logger, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpExceptionFilter } from './http-exception.filter.js';

function run(exception: Error, url = '/planning/generate') {
    let status = 0;
    let body: any;
    const response = {
        status(code: number) { status = code; return this; },
        json(payload: unknown) { body = payload; },
    };
    const host = {
        switchToHttp: () => ({
            getResponse: () => response,
            getRequest:  () => ({ method: 'POST', url }),
        }),
    };
    new HttpExceptionFilter().catch(exception as any, host as any);
    return { status, body };
}

describe('HttpExceptionFilter', () => {
    afterEach(() => vi.restoreAllMocks());

    it('keeps the standard body when the exception has no details', () => {
        const { body } = run(new UnprocessableEntityException({ message: 'bad', error: 'SOME_CODE' }));

        expect(Object.keys(body)).toEqual(['statusCode', 'error', 'message', 'path', 'timestamp']);
    });

    it('forwards the structured details of a 4xx domain exception', () => {
        const { status, body } = run(new UnprocessableEntityException({
            message: 'fix settings',
            error:   'PLANNING_SETTINGS_MISSING',
            details: { missingKeys: ['stop_service_minutes'] },
        }));

        expect(status).toBe(422);
        expect(body.error).toBe('PLANNING_SETTINGS_MISSING');
        expect(body.details).toEqual({ missingKeys: ['stop_service_minutes'] });
    });

    it('never forwards details of a 5xx', () => {
        vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

        const { body } = run(new InternalServerErrorException({ message: 'boom', error: 'X', details: { secret: 1 } }));

        expect(body.details).toBeUndefined();
    });

    it('never echoes the tracking token of a public URL in the body', () => {
        const { body } = run(
            new UnprocessableEntityException({ message: 'bad', error: 'SOME_CODE' }),
            '/api/public/tracking/5b0a7c1e-0d0e-4a44-9d5f-3a1b2c3d4e5f/reschedule',
        );

        expect(body.path).toBe('/api/public/tracking/:token/reschedule');
        expect(JSON.stringify(body)).not.toContain('5b0a7c1e');
    });

    it('never writes the tracking token of a public URL to the log of a 5xx', () => {
        const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

        run(new InternalServerErrorException({ message: 'boom', error: 'X' }), '/api/public/tracking/5b0a7c1e-0d0e-4a44-9d5f-3a1b2c3d4e5f');

        expect(error).toHaveBeenCalledTimes(1);
        expect(String(error.mock.calls[0][0])).toContain('/api/public/tracking/:token');
        expect(String(error.mock.calls[0][0])).not.toContain('5b0a7c1e');
    });

    it('keeps the plain path of every other URL', () => {
        const { body } = run(new UnprocessableEntityException({ message: 'bad', error: 'SOME_CODE' }), '/api/route-batches/7');

        expect(body.path).toBe('/api/route-batches/7');
    });

    it('answers a 503 with its domain code', () => {
        vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

        const { status, body } = run(new ServiceUnavailableException({ message: 'down', error: 'OSRM_UNAVAILABLE' }));

        expect(status).toBe(503);
        expect(body.error).toBe('OSRM_UNAVAILABLE');
    });
});
