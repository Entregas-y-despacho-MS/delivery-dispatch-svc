import { describe, expect, it, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import type { SettingsService } from '../../../modules/settings/services/settings.service.js';
import { DeliveryAttemptsService } from './delivery-attempts.service.js';

function build(row: { not_delivered: number; incidents: number } | undefined, limit = 3) {
    const manager = { query: vi.fn().mockResolvedValue(row ? [row] : []) } as unknown as EntityManager & { query: ReturnType<typeof vi.fn> };
    const settings = { getNumber: vi.fn().mockResolvedValue(limit) };
    return { service: new DeliveryAttemptsService(settings as unknown as SettingsService), manager, settings };
}

describe('DeliveryAttemptsService', () => {
    it('adds the not_delivered entries and the incidents that count as an attempt', async () => {
        const { service, manager } = build({ not_delivered: 1, incidents: 1 });

        expect(await service.count(manager, 7)).toEqual({ notDelivered: 1, incidents: 1, used: 2, limit: 3, limitReached: false });
        expect(manager.query.mock.calls[0][1]).toEqual([7]);
    });

    it('reaches the limit exactly at max_delivery_attempts', async () => {
        const { service, manager } = build({ not_delivered: 2, incidents: 1 });

        expect((await service.count(manager, 7)).limitReached).toBe(true);
    });

    it('reads the limit from the max_delivery_attempts setting with 3 as fallback', async () => {
        const { service, manager, settings } = build({ not_delivered: 0, incidents: 0 }, 5);

        expect((await service.count(manager, 7)).limit).toBe(5);
        expect(settings.getNumber).toHaveBeenCalledWith('max_delivery_attempts', 3);
    });

    it('counts a dispatch with no failures as zero attempts', async () => {
        const { service, manager } = build(undefined);

        expect(await service.count(manager, 7)).toMatchObject({ used: 0, limitReached: false });
    });

    it('counts only incidents whose reason counts as an attempt, entries into not_delivered and never reschedule rows', async () => {
        const { service, manager } = build({ not_delivered: 0, incidents: 0 });
        await service.count(manager, 7);
        const sql = String(manager.query.mock.calls[0][0]);

        expect(sql).toContain('ir.counts_as_attempt = TRUE');
        expect(sql).toContain("e.metadata->>'status' = 'not_delivered'");
        expect(sql).toContain("<> 'not_delivered'");
        expect(sql).not.toContain('dispatch_reschedules');
    });
});
