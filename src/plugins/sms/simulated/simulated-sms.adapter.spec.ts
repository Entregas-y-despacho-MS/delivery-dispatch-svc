import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimulatedSmsAdapter } from './simulated-sms.adapter.js';

describe('simulated SMS', () => {
    afterEach(() => vi.restoreAllMocks());
    it.each([
        ['development', undefined], ['development', false], ['development', 'true'],
        ['production', true], ['test', true], ['debug', true], ['shared', true], [undefined, true],
    ])('redacts sensitive message and phone for environment %s and flag %s', async (environment, flag) => {
        const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
        const config = new ConfigService({ NODE_ENV: environment, SMS_SIMULATED_LOG_BODY: flag });
        await new SimulatedSmsAdapter(config).send({ to: '+59170000000', body: 'OTP 123456' });
        expect(log).toHaveBeenCalledWith({ event: 'sms.sent', adapter: 'simulated', message: '[REDACTED]' });
        expect(JSON.stringify(log.mock.calls)).not.toMatch(/123456|59170000000/);
    });
    it('logs the simulated body and masked phone only with explicit development opt-in', async () => {
        const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
        const config = new ConfigService({ NODE_ENV: 'development', SMS_SIMULATED_LOG_BODY: true });
        await new SimulatedSmsAdapter(config).send({ to: '+59171234567', body: 'OTP 123456' });
        expect(log).toHaveBeenCalledWith({ event: 'sms.sent', adapter: 'simulated', recipient: '****4567', message: 'OTP 123456' });
        expect(JSON.stringify(log.mock.calls)).not.toContain('+59171234567');
    });
    it('never reveals a complete short recipient even in the local opt-in mode', async () => {
        const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
        const config = new ConfigService({ NODE_ENV: 'development', SMS_SIMULATED_LOG_BODY: true });
        await new SimulatedSmsAdapter(config).send({ to: '1234', body: 'development message' });
        expect(log).toHaveBeenCalledWith(expect.objectContaining({ recipient: '****' }));
    });
});
