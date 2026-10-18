import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimulatedSmsAdapter } from './simulated-sms.adapter.js';

describe('simulated SMS', () => {
    afterEach(() => vi.restoreAllMocks());
    it('records a structured acceptance without phone or sensitive message', async () => {
        const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
        await new SimulatedSmsAdapter().send({ to: '+59170000000', body: 'OTP 123456' });
        expect(log).toHaveBeenCalledWith({ event: 'sms.sent', adapter: 'simulated', message: '[REDACTED]' });
        expect(JSON.stringify(log.mock.calls)).not.toMatch(/123456|59170000000/);
    });
});
