import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LogMailerAdapter } from './log.adapter.js';

describe('LogMailerAdapter', () => {
    let adapter: LogMailerAdapter;
    let log: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        adapter = new LogMailerAdapter({ bounceEmail: 'bounce@example.test' } as any);
        log = vi.spyOn((adapter as any).logger, 'log').mockImplementation(() => undefined);
    });

    it('records a successful delivery attempt and returns sent', async () => {
        await expect(adapter.send({ to: 'customer@example.test', subject: 'Promise', template: 'promise' }))
            .resolves.toEqual({ status: 'sent' });

        expect(log).toHaveBeenCalledOnce();
        expect(log.mock.calls[0][0]).toContain('customer@example.test');
        expect(log.mock.calls[0][0]).toContain('promise');
    });

    it('simulates a bounce for the configured recipient', async () => {
        await expect(adapter.send({ to: 'BOUNCE@example.test', subject: 'Promise', template: 'promise' }))
            .resolves.toEqual({ status: 'bounced' });

        expect(log.mock.calls[0][0]).toContain('"result":"bounced"');
    });
});
