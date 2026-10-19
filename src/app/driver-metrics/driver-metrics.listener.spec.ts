import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { MemoryCacheAdapter } from '../../plugins/cache/memory/memory-cache.adapter.js';
import { CacheUnavailableException } from '../../plugins/cache/exceptions/index.js';
import type { DispatchStatusChangedEvent } from '../dispatch-status/dispatch-status-changed.event.js';
import { allMetricsCacheKeys, metricsCacheKey, metricsEpochKey } from './domain/metrics-cache-key.js';
import { DriverMetricsPeriod } from './domain/metrics-period.js';
import { DriverMetricsListener } from './driver-metrics.listener.js';
import { DriverMetricsService } from './services/driver-metrics.service.js';

const event = (status: string, previousStatus = 'in_transit'): DispatchStatusChangedEvent => ({ dispatchId: 50, status, previousStatus, version: 1, updatedAt: '2026-10-19T15:00:00.000Z' });

describe('DriverMetricsListener', () => {
    const repository = { aggregate: vi.fn(), findDriverIdOfDispatch: vi.fn() };
    let cache: MemoryCacheAdapter;
    let listener: DriverMetricsListener;
    let warn: ReturnType<typeof vi.spyOn>;

    const fill = async (driverId: number): Promise<void> => {
        for (const key of allMetricsCacheKeys(driverId)) await cache.set(key, '{"cached":true}');
    };

    afterEach(() => { vi.restoreAllMocks(); });

    beforeEach(() => {
        repository.aggregate.mockReset();
        repository.findDriverIdOfDispatch.mockReset().mockResolvedValue(7);
        cache = new MemoryCacheAdapter();
        listener = new DriverMetricsListener(repository as never, new DriverMetricsService(repository as never, cache));
        warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    it('a confirmed delivery drops the three periods of that driver only', async () => {
        await fill(7);
        await fill(8);

        await listener.handle(event('delivered'));

        for (const key of allMetricsCacheKeys(7)) expect(await cache.get(key)).toBeNull();
        for (const key of allMetricsCacheKeys(8)) expect(await cache.get(key)).not.toBeNull();
        expect(repository.findDriverIdOfDispatch).toHaveBeenCalledWith(50);
    });

    it.each(['in_transit', 'not_delivered', 'returned', 'cancelled', 'assigned'])('%s does not touch the cache', async (status) => {
        await fill(7);

        await listener.handle(event(status));

        expect(repository.findDriverIdOfDispatch).not.toHaveBeenCalled();
        expect(await cache.get(metricsCacheKey(7, DriverMetricsPeriod.TODAY))).not.toBeNull();
    });

    it('a dispatch that LEAVES delivered also drops the answers (it stops counting)', async () => {
        await fill(7);

        await listener.handle(event('assigned', 'delivered'));

        for (const key of allMetricsCacheKeys(7)) expect(await cache.get(key)).toBeNull();
    });

    it('a delivery moves the epoch, so an answer being computed is not stored', async () => {
        const before = await cache.get(metricsEpochKey(7));

        await listener.handle(event('delivered'));

        expect(await cache.get(metricsEpochKey(7))).not.toBe(before);
    });

    it('a dispatch without a driver invalidates nothing', async () => {
        repository.findDriverIdOfDispatch.mockResolvedValue(null);
        await fill(7);

        await listener.handle(event('delivered'));

        expect(await cache.get(metricsCacheKey(7, DriverMetricsPeriod.TODAY))).not.toBeNull();
    });

    it('Redis down: warns for each key and does not throw', async () => {
        vi.spyOn(cache, 'delete').mockRejectedValue(new CacheUnavailableException());

        await expect(listener.handle(event('delivered'))).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(3);
    });

    it('one failing key does not leave the others stale', async () => {
        await fill(7);
        const original = cache.delete.bind(cache);
        vi.spyOn(cache, 'delete').mockImplementation(async (key) => {
            if (key === metricsCacheKey(7, DriverMetricsPeriod.TODAY)) throw new CacheUnavailableException();
            await original(key);
        });

        await listener.handle(event('delivered'));

        expect(await cache.get(metricsCacheKey(7, DriverMetricsPeriod.WEEK))).toBeNull();
        expect(await cache.get(metricsCacheKey(7, DriverMetricsPeriod.MONTH))).toBeNull();
    });

    it('a failing lookup is only logged, never thrown into the delivery', async () => {
        repository.findDriverIdOfDispatch.mockRejectedValue(new Error('db down'));

        await expect(listener.handle(event('delivered'))).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(1);
    });
});
