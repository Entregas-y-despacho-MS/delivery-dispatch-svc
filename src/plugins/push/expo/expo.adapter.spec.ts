import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExpoPushAdapter } from './expo.adapter.js';

const TOKEN = 'ExponentPushToken[0123456789abcdef012345]';

function build() {
    const client = {
        chunkPushNotifications: vi.fn((messages: unknown[]) => [messages]),
        sendPushNotificationsAsync: vi.fn(),
        chunkPushNotificationReceiptIds: vi.fn((ids: string[]) => [ids]),
        getPushNotificationReceiptsAsync: vi.fn(),
    };
    return { adapter: new ExpoPushAdapter(client as any), client };
}

describe('ExpoPushAdapter', () => {
    beforeEach(() => vi.clearAllMocks());

    it('sends a sound notification and returns the ticket receipt id', async () => {
        const { adapter, client } = build();
        client.sendPushNotificationsAsync.mockResolvedValue([{ status: 'ok', id: 'receipt-1' }]);

        await expect(adapter.send([{
            to: TOKEN,
            title: 'Nueva ruta asignada',
            body: 'Tienes 3 pedidos en Centro',
            data: { dispatchId: 42, zoneName: 'Centro', priority: 'urgent' },
        }])).resolves.toEqual([{ token: TOKEN, status: 'accepted', receiptId: 'receipt-1' }]);
        expect(client.sendPushNotificationsAsync).toHaveBeenCalledWith([expect.objectContaining({
            to: TOKEN,
            sound: 'default',
            priority: 'high',
            data: { dispatchId: 42, zoneName: 'Centro', priority: 'urgent' },
        })]);
    });

    it('marks a token rejected by the push ticket as invalid', async () => {
        const invalid = 'ExponentPushToken[abcdef0123456789abcdef]';
        const valid = 'ExponentPushToken[1234567890abcdef123456]';
        const { client } = build();
        client.sendPushNotificationsAsync.mockResolvedValue([
            { status: 'error', message: 'unregistered', details: { error: 'DeviceNotRegistered' } },
            { status: 'error', message: 'bad payload', details: { error: 'MessageTooBig' } },
        ]);
        const anotherAdapter = new ExpoPushAdapter(client as any);

        await expect(anotherAdapter.send([
            { to: invalid, title: 'a', body: 'b' },
            { to: valid, title: 'a', body: 'b' },
        ])).resolves.toEqual([
            { token: invalid, status: 'invalid-token', error: 'DeviceNotRegistered' },
            { token: valid, status: 'permanent-error', error: 'MessageTooBig' },
        ]);
    });

    it('maps asynchronous DeviceNotRegistered receipts and leaves missing receipts pending', async () => {
        const { adapter, client } = build();
        client.getPushNotificationReceiptsAsync.mockResolvedValue({
            'receipt-1': { status: 'error', message: 'unregistered', details: { error: 'DeviceNotRegistered' } },
        });

        await expect(adapter.getReceipts([
            { token: TOKEN, receiptId: 'receipt-1' },
            { token: 'other-token', receiptId: 'receipt-2' },
        ])).resolves.toEqual([{
            token: TOKEN,
            receiptId: 'receipt-1',
            status: 'invalid-token',
            error: 'DeviceNotRegistered',
        }]);
    });

    it('marks temporary service failures as retryable', async () => {
        const { adapter, client } = build();
        client.sendPushNotificationsAsync.mockRejectedValue({ statusCode: 503, message: 'unavailable' });

        await expect(adapter.send([{ to: TOKEN, title: 'a', body: 'b' }])).resolves.toEqual([{
            token: TOKEN,
            status: 'retryable-error',
            error: 'unavailable',
        }]);
    });
});
