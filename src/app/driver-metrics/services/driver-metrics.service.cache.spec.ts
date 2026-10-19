import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { MemoryCacheAdapter } from '../../../plugins/cache/memory/memory-cache.adapter.js';
import { CacheUnavailableException } from '../../../plugins/cache/exceptions/index.js';
import { METRICS_CACHE_TTL_SECONDS, allMetricsCacheKeys, metricsCacheKey } from '../domain/metrics-cache-key.js';
import { DriverMetricsPeriod } from '../domain/metrics-period.js';
import { DriverMetricsService } from './driver-metrics.service.js';

const ROW = { deliveredCount: 4, onTimeCount: 3, assignedCount: 5, ratingsCount: 2, ratingAverage: 4.5 };

describe('DriverMetricsService cache', () => {
    const repository = { aggregate: vi.fn() };
    let cache: MemoryCacheAdapter;
    let service: DriverMetricsService;
    let warn: ReturnType<typeof vi.spyOn>;

    afterEach(() => { vi.restoreAllMocks(); });

    beforeEach(() => {
        repository.aggregate.mockReset().mockResolvedValue(ROW);
        cache = new MemoryCacheAdapter();
        service = new DriverMetricsService(repository as never, cache);
        warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    it('names the keys metrics:driver:{driverId}:{period} and lives five minutes', () => {
        expect(metricsCacheKey(7, DriverMetricsPeriod.WEEK)).toBe('metrics:driver:7:week');
        expect(allMetricsCacheKeys(7)).toEqual(['metrics:driver:7:today', 'metrics:driver:7:week', 'metrics:driver:7:month']);
        expect(METRICS_CACHE_TTL_SECONDS).toBe(300);
    });

    it('miss: computes from PostgreSQL and stores the answer with a 5-minute TTL', async () => {
        const setWithTtl = vi.spyOn(cache, 'setWithTtl');

        const metrics = await service.get(7, DriverMetricsPeriod.TODAY);

        expect(metrics.deliveredCount).toBe(4);
        expect(repository.aggregate).toHaveBeenCalledTimes(1);
        expect(setWithTtl).toHaveBeenCalledWith('metrics:driver:7:today', JSON.stringify(metrics), 300);
    });

    it('hit: the second request is answered from the cache without touching PostgreSQL', async () => {
        const first = await service.get(7, DriverMetricsPeriod.TODAY);
        repository.aggregate.mockClear();

        await expect(service.get(7, DriverMetricsPeriod.TODAY)).resolves.toEqual(first);
        expect(repository.aggregate).not.toHaveBeenCalled();
    });

    it('each driver and each period have their own entry', async () => {
        await service.get(7, DriverMetricsPeriod.TODAY);
        await service.get(7, DriverMetricsPeriod.WEEK);
        await service.get(8, DriverMetricsPeriod.TODAY);

        expect(repository.aggregate).toHaveBeenCalledTimes(3);
    });

    it('invalidation: once the keys are deleted the next request recomputes', async () => {
        await service.get(7, DriverMetricsPeriod.TODAY);
        for (const key of allMetricsCacheKeys(7)) await cache.delete(key);
        repository.aggregate.mockClear().mockResolvedValue({ ...ROW, deliveredCount: 5 });

        expect((await service.get(7, DriverMetricsPeriod.TODAY)).deliveredCount).toBe(5);
        expect(repository.aggregate).toHaveBeenCalledTimes(1);
    });

    it('Redis down on read and write: answers from PostgreSQL and only warns', async () => {
        vi.spyOn(cache, 'get').mockRejectedValue(new CacheUnavailableException());
        vi.spyOn(cache, 'setWithTtl').mockRejectedValue(new CacheUnavailableException());

        await expect(service.get(7, DriverMetricsPeriod.MONTH)).resolves.toMatchObject({ deliveredCount: 4, ratingsCount: 2 });
        // One warning for the failed read; with the cache down the epoch is unknown, so nothing is written (no second warning).
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('an unreadable cached value is treated as a miss', async () => {
        await cache.set('metrics:driver:7:today', '{not json');

        await expect(service.get(7, DriverMetricsPeriod.TODAY)).resolves.toMatchObject({ deliveredCount: 4 });
        expect(repository.aggregate).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalled();
    });

    it('a cached value with the wrong shape is also recomputed', async () => {
        await cache.set('metrics:driver:7:today', JSON.stringify({ hello: 'world' }));

        await expect(service.get(7, DriverMetricsPeriod.TODAY)).resolves.toMatchObject({ deliveredCount: 4 });
    });

    it('a driver with no history is cached too (zeros and rating null)', async () => {
        repository.aggregate.mockResolvedValue({ deliveredCount: 0, onTimeCount: 0, assignedCount: 0, ratingsCount: 0, ratingAverage: null });

        const first = await service.get(9, DriverMetricsPeriod.TODAY);
        repository.aggregate.mockClear();

        expect(first).toMatchObject({ deliveredCount: 0, rating: null, ratingsCount: 0 });
        await expect(service.get(9, DriverMetricsPeriod.TODAY)).resolves.toEqual(first);
        expect(repository.aggregate).not.toHaveBeenCalled();
    });
});
