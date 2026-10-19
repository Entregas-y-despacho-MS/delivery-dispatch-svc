import { describe, expect, it, vi } from 'vitest';
import { SimulatedPushAdapter } from '../../plugins/push/simulated/simulated.adapter.js';
import { PushReceiptMonitor } from './push-receipt-monitor.js';

const START = new Date('2026-10-18T10:00:00.000Z');
const RECEIPT = { token: 'expo-token', receiptId: 'receipt-1' };

describe('PushReceiptMonitor', () => {
    it('waits for the receipt window and revokes a token rejected by the provider', async () => {
        const provider = new SimulatedPushAdapter();
        const pushTokens = { revokeByToken: vi.fn().mockResolvedValue(1) };
        const monitor = new PushReceiptMonitor(provider, pushTokens as any);
        monitor.add([RECEIPT], START);
        provider.receiptResults.push([{
            ...RECEIPT,
            status: 'invalid-token',
            error: 'DeviceNotRegistered',
        }]);

        await monitor.poll(new Date(START.getTime() + 14 * 60 * 1000));
        expect(provider.receiptRequests).toHaveLength(0);

        await monitor.poll(new Date(START.getTime() + 15 * 60 * 1000));
        expect(provider.receiptRequests[0]).toEqual([expect.objectContaining(RECEIPT)]);
        expect(pushTokens.revokeByToken).toHaveBeenCalledWith(RECEIPT.token);
    });

    it('keeps receipts that are not ready and retries them at the next interval', async () => {
        const provider = new SimulatedPushAdapter();
        const monitor = new PushReceiptMonitor(provider, { revokeByToken: vi.fn() } as any);
        monitor.add([RECEIPT], START);

        await monitor.poll(new Date(START.getTime() + 15 * 60 * 1000));
        await monitor.poll(new Date(START.getTime() + 29 * 60 * 1000));
        expect(provider.receiptRequests).toHaveLength(1);

        await monitor.poll(new Date(START.getTime() + 30 * 60 * 1000));
        expect(provider.receiptRequests).toHaveLength(2);
    });
});
