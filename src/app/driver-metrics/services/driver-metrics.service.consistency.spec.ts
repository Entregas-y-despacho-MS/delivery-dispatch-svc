import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { MemoryCacheAdapter } from '../../../plugins/cache/memory/memory-cache.adapter.js';
import { CacheUnavailableException } from '../../../plugins/cache/exceptions/index.js';
import { METRICS_CACHE_TTL_SECONDS, METRICS_EPOCH_TTL_SECONDS, allMetricsCacheKeys, metricsCacheKey, metricsEpochKey } from '../domain/metrics-cache-key.js';
import { DriverMetricsPeriod } from '../domain/metrics-period.js';
import { DriverMetricsService } from './driver-metrics.service.js';

const ROW = { deliveredCount: 4, onTimeCount: 3, assignedCount: 5, ratingsCount: 2, ratingAverage: 4.5 };
const TODAY_KEY = metricsCacheKey(7, DriverMetricsPeriod.TODAY);

describe('DriverMetricsService cache consistency', () => {
    const repository = { aggregate: vi.fn() };
    let cache: MemoryCacheAdapter;
    let service: DriverMetricsService;
    let warn: ReturnType<typeof vi.spyOn>;
    const stored = async (): Promise<string | null> => cache.get(TODAY_KEY);

    afterEach(() => { vi.restoreAllMocks(); });

    beforeEach(() => {
        repository.aggregate.mockReset().mockResolvedValue(ROW);
        cache = new MemoryCacheAdapter();
        service = new DriverMetricsService(repository as never, cache);
        warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    it('keeps the epoch key apart from the answers and longer-lived than them', () => {
        expect(metricsEpochKey(7)).toBe('metrics:driver:7:epoch');
        expect(allMetricsCacheKeys(7)).not.toContain(metricsEpochKey(7));
        expect(METRICS_EPOCH_TTL_SECONDS).toBeGreaterThan(METRICS_CACHE_TTL_SECONDS);
    });

    describe('answers from another day', () => {
        const YESTERDAY = new Date('2026-10-20T15:00:00Z');
        const TODAY = new Date('2026-10-21T15:00:00Z');

        it('yesterday\'s `today` is not served after midnight: it is recomputed with the new days and overwritten', async () => {
            const old = await service.get(7, DriverMetricsPeriod.TODAY, YESTERDAY);
            repository.aggregate.mockClear().mockResolvedValue({ ...ROW, deliveredCount: 9 });

            const fresh = await service.get(7, DriverMetricsPeriod.TODAY, TODAY);

            expect(old.to).toBe('2026-10-20');
            expect(fresh).toMatchObject({ from: '2026-10-21', to: '2026-10-21', deliveredCount: 9 });
            expect(repository.aggregate).toHaveBeenCalledTimes(1);
            expect(JSON.parse((await stored())!)).toMatchObject({ to: '2026-10-21' });
        });

        it('last week\'s and last month\'s answers are not reused when the week or the month changes', async () => {
            await service.get(7, DriverMetricsPeriod.WEEK, new Date('2026-10-25T15:00:00Z')); // Sunday, week of the 19th
            await service.get(7, DriverMetricsPeriod.MONTH, new Date('2026-10-31T15:00:00Z'));
            repository.aggregate.mockClear();

            const week = await service.get(7, DriverMetricsPeriod.WEEK, new Date('2026-10-26T15:00:00Z')); // Monday
            const month = await service.get(7, DriverMetricsPeriod.MONTH, new Date('2026-11-02T15:00:00Z'));

            expect(week.from).toBe('2026-10-26');
            expect(month.from).toBe('2026-11-01');
            expect(repository.aggregate).toHaveBeenCalledTimes(2);
        });

        it('within the same Bolivia day the answer is still a hit', async () => {
            await service.get(7, DriverMetricsPeriod.TODAY, new Date('2026-10-21T13:00:00Z'));
            repository.aggregate.mockClear();

            await service.get(7, DriverMetricsPeriod.TODAY, new Date('2026-10-22T03:00:00Z')); // 23:00 in Bolivia, same day

            expect(repository.aggregate).not.toHaveBeenCalled();
        });
    });

    describe('cached values are validated field by field', () => {
        const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/La_Paz' }).format(new Date());
        const valid = { period: 'today', from: day, to: day, deliveredCount: 1, onTimePercentage: 100, assignedCount: 1, rating: null, ratingsCount: 0 };

        it.each([
            ['another period', { period: 'week' }],
            ['no period', { period: undefined }],
            ['a text count', { deliveredCount: '1' }],
            ['a negative count', { assignedCount: -1 }],
            ['a fractional count', { deliveredCount: 1.5 }],
            ['a percentage above 100', { onTimePercentage: 101 }],
            ['a rating out of 1..5', { rating: 7, ratingsCount: 1 }],
            ['a rating without ratings', { rating: 4, ratingsCount: 0 }],
            ['ratings without a rating', { rating: null, ratingsCount: 3 }],
            ['no days', { from: undefined }],
        ])('rejects %s and recomputes', async (_label, change) => {
            await cache.set(TODAY_KEY, JSON.stringify({ ...valid, ...change }));

            const metrics = await service.get(7, DriverMetricsPeriod.TODAY);

            expect(metrics.deliveredCount).toBe(4);
            expect(repository.aggregate).toHaveBeenCalledTimes(1);
        });

        it('accepts the complete valid value', async () => {
            await cache.set(TODAY_KEY, JSON.stringify(valid));

            expect((await service.get(7, DriverMetricsPeriod.TODAY)).deliveredCount).toBe(1);
            expect(repository.aggregate).not.toHaveBeenCalled();
        });
    });

    describe('a confirmation that races a request', () => {
        it('invalidate moves the epoch and drops the answers', async () => {
            await service.get(7, DriverMetricsPeriod.TODAY);
            const before = await cache.get(metricsEpochKey(7));

            await service.invalidate(7);

            expect(await stored()).toBeNull();
            expect(await cache.get(metricsEpochKey(7))).not.toBe(before);
        });

        it('a delivery confirmed WHILE the answer is computed: the old answer is not stored', async () => {
            repository.aggregate.mockImplementation(async () => {
                await service.invalidate(7); // the confirmation lands in the middle of the computation
                return ROW;
            });

            const metrics = await service.get(7, DriverMetricsPeriod.TODAY);

            expect(metrics.deliveredCount).toBe(4); // this request still answers with what it computed
            expect(await stored()).toBeNull();      // the next one computes again
        });

        it('and it never even writes it, so no reader can see the old answer in between', async () => {
            const setWithTtl = vi.spyOn(cache, 'setWithTtl');
            repository.aggregate.mockImplementation(async () => {
                await service.invalidate(7);
                return ROW;
            });

            await service.get(7, DriverMetricsPeriod.TODAY);

            expect(setWithTtl).not.toHaveBeenCalled();
        });

        it('a delivery confirmed AFTER the check and the write: the entry that reappears is removed', async () => {
            const original = cache.setWithTtl.bind(cache);
            vi.spyOn(cache, 'setWithTtl').mockImplementationOnce(async (key, value, ttl) => {
                await service.invalidate(7); // the confirmation (epoch + delete) lands right before the stale write
                await original(key, value, ttl);
            });

            await service.get(7, DriverMetricsPeriod.TODAY);

            expect(await stored()).toBeNull();
        });

        it('only the driver of the confirmation loses the answers in flight', async () => {
            repository.aggregate.mockImplementation(async () => {
                await service.invalidate(8);
                return ROW;
            });

            await service.get(7, DriverMetricsPeriod.TODAY);

            expect(await stored()).not.toBeNull();
        });

        it('with no invalidation yet (no epoch) the answer is stored', async () => {
            await service.get(7, DriverMetricsPeriod.TODAY);

            expect(await cache.get(metricsEpochKey(7))).toBeNull();
            expect(await stored()).not.toBeNull();
        });

        it('if the epoch cannot be read the answer is returned but not stored', async () => {
            const original = cache.get.bind(cache);
            vi.spyOn(cache, 'get').mockImplementation(async (key) => {
                if (key === metricsEpochKey(7)) throw new CacheUnavailableException();
                return original(key);
            });

            await expect(service.get(7, DriverMetricsPeriod.TODAY)).resolves.toMatchObject({ deliveredCount: 4 });
            expect(await stored()).toBeNull();
        });

        it('if the epoch cannot be moved the keys are still dropped and it only warns', async () => {
            await service.get(7, DriverMetricsPeriod.TODAY);
            vi.spyOn(cache, 'increment').mockRejectedValue(new CacheUnavailableException());

            await service.invalidate(7);

            expect(await stored()).toBeNull();
            expect(warn).toHaveBeenCalledTimes(1);
        });
    });
});
