import { describe, expect, it, vi } from 'vitest';
import { SimulatedPushAdapter } from '../../plugins/push/simulated/simulated.adapter.js';
import { PushReceiptMonitor } from './push-receipt-monitor.js';
import { RoutePushNotificationService } from './route-push-notification.service.js';

const EVENT = {
    routeId: 18,
    driverId: 4,
    vehicleId: 7,
    dispatchIds: [31, 32, 33],
    dispatches: [
        { dispatchId: 31, priority: 'normal' },
        { dispatchId: 32, priority: 'urgent' },
        { dispatchId: 33, priority: 'normal' },
    ],
    zoneName: 'Centro',
    version: 5,
};

describe('RoutePushNotificationService', () => {
    it('sends one frozen batch summary per active device and registers provider receipts', async () => {
        const provider = new SimulatedPushAdapter();
        provider.sendResults.push([
            { token: 'device-1', status: 'accepted', receiptId: 'receipt-1' },
            { token: 'device-2', status: 'accepted', receiptId: 'receipt-2' },
        ]);
        const tokenService = {
            findActiveByUserId: vi.fn().mockResolvedValue([{ token: 'device-1' }, { token: 'device-2' }]),
            revokeByToken: vi.fn(),
        };
        const monitor = new PushReceiptMonitor(provider, tokenService as any);
        const service = new RoutePushNotificationService(tokenService as any, provider, monitor);

        await service.notify(EVENT);

        expect(provider.sent).toEqual([
            {
                to: 'device-1',
                title: 'Nueva ruta asignada',
                body: 'Tienes 3 pedidos asignados en Centro.',
                data: { dispatchId: 31, zoneName: 'Centro', priority: 'urgent', routeId: 18 },
            },
            {
                to: 'device-2',
                title: 'Nueva ruta asignada',
                body: 'Tienes 3 pedidos asignados en Centro.',
                data: { dispatchId: 31, zoneName: 'Centro', priority: 'urgent', routeId: 18 },
            },
        ]);
        await monitor.poll(new Date(Date.now() + 16 * 60 * 1000));
        expect(provider.receiptRequests[0]).toEqual([
            expect.objectContaining({ token: 'device-1', receiptId: 'receipt-1' }),
            expect.objectContaining({ token: 'device-2', receiptId: 'receipt-2' }),
        ]);
    });

    it('revokes tokens rejected in the immediate provider ticket', async () => {
        const provider = new SimulatedPushAdapter();
        provider.sendResults.push([{ token: 'bad-device', status: 'invalid-token', error: 'DeviceNotRegistered' }]);
        const tokenService = {
            findActiveByUserId: vi.fn().mockResolvedValue([{ token: 'bad-device' }]),
            revokeByToken: vi.fn().mockResolvedValue(1),
        };
        const service = new RoutePushNotificationService(
            tokenService as any,
            provider,
            new PushReceiptMonitor(provider, tokenService as any),
        );

        await expect(service.notify(EVENT)).resolves.toBeUndefined();
        expect(tokenService.revokeByToken).toHaveBeenCalledWith('bad-device');
    });

    it('does not call the provider when the driver has no active tokens', async () => {
        const provider = new SimulatedPushAdapter();
        const tokenService = { findActiveByUserId: vi.fn().mockResolvedValue([]), revokeByToken: vi.fn() };
        const service = new RoutePushNotificationService(
            tokenService as any,
            provider,
            new PushReceiptMonitor(provider, tokenService as any),
        );

        await service.notify(EVENT);
        expect(provider.sent).toHaveLength(0);
    });

    it('swallows token lookup failures so the assigned route remains successful', async () => {
        const provider = new SimulatedPushAdapter();
        const tokenService = { findActiveByUserId: vi.fn().mockRejectedValue(new Error('database unavailable')) };
        const service = new RoutePushNotificationService(
            tokenService as any,
            provider,
            new PushReceiptMonitor(provider, tokenService as any),
        );

        await expect(service.notify(EVENT)).resolves.toBeUndefined();
        expect(provider.sent).toHaveLength(0);
    });
});
