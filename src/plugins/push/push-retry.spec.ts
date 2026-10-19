import { describe, expect, it, vi } from 'vitest';
import { SimulatedPushAdapter } from './simulated/simulated.adapter.js';
import { sendWithPushRetry } from './push-retry.js';

const MESSAGE = { to: 'expo-token', title: 'New route', body: '2 orders', data: { priority: 'normal' } };

describe('sendWithPushRetry', () => {
    it('retries temporary errors with exponential backoff and stops after success', async () => {
        const provider = new SimulatedPushAdapter();
        provider.sendResults.push(
            [{ token: MESSAGE.to, status: 'retryable-error', error: 'temporary outage' }],
            [{ token: MESSAGE.to, status: 'accepted', receiptId: 'receipt-1' }],
        );
        const wait = vi.fn(async () => undefined);

        await expect(sendWithPushRetry(provider, [MESSAGE], wait)).resolves.toEqual([
            { token: MESSAGE.to, status: 'accepted', receiptId: 'receipt-1' },
        ]);
        expect(provider.sent).toHaveLength(2);
        expect(wait).toHaveBeenCalledOnce();
        expect(wait).toHaveBeenCalledWith(500);
    });

    it('makes no more than three attempts and never retries permanent errors', async () => {
        const provider = new SimulatedPushAdapter();
        provider.sendResults.push(
            [{ token: MESSAGE.to, status: 'retryable-error', error: 'temporary outage' }],
            [{ token: MESSAGE.to, status: 'retryable-error', error: 'still down' }],
            [{ token: MESSAGE.to, status: 'retryable-error', error: 'still down' }],
        );
        const wait = vi.fn(async () => undefined);

        await expect(sendWithPushRetry(provider, [MESSAGE], wait)).resolves.toEqual([
            { token: MESSAGE.to, status: 'retryable-error', error: 'still down' },
        ]);
        expect(provider.sent).toHaveLength(3);
        expect(wait.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([500, 1000]);
    });

    it('returns permanent provider errors without retrying', async () => {
        const provider = new SimulatedPushAdapter();
        provider.sendResults.push([{ token: MESSAGE.to, status: 'permanent-error', error: 'invalid payload' }]);

        await expect(sendWithPushRetry(provider, [MESSAGE], vi.fn())).resolves.toEqual([
            { token: MESSAGE.to, status: 'permanent-error', error: 'invalid payload' },
        ]);
        expect(provider.sent).toHaveLength(1);
    });
});
