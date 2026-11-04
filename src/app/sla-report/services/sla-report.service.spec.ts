import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidHistoryDateRangeException } from '../../../modules/dispatch/dispatch-history/exceptions/index.js';
import { SlaGroupBy } from '../domain/sla-group-by.js';
import type { SlaGroupSums } from '../domain/sla-metrics.js';
import { SlaRangeTooLargeException } from '../exceptions/index.js';
import { SlaReportService } from './sla-report.service.js';

const FROM = '2026-10-01';
const TO = '2026-10-31';
const KEY = (groupBy: SlaGroupBy, from = FROM, to = TO) => `reports:sla:${groupBy}:${from}:${to}`;

const sums = (overrides: Partial<SlaGroupSums> = {}): SlaGroupSums => ({
    groupId: 1, groupName: 'Zona Norte',
    closedCount: 5, deliveredCount: 4, onTimeCount: 3, lateCount: 1, delayMinutesSum: 20, cycleCount: 4, cycleMinutesSum: 400, incidentCount: 2,
    ...overrides,
});

describe('SlaReportService', () => {
    let warn: ReturnType<typeof vi.spyOn>;
    let aggregate: ReturnType<typeof vi.fn>;
    let store: Map<string, string>;
    let cache: { get: ReturnType<typeof vi.fn>; setWithTtl: ReturnType<typeof vi.fn> };
    let service: SlaReportService;

    beforeEach(() => {
        warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        aggregate = vi.fn().mockResolvedValue([sums()]);
        store = new Map();
        cache = {
            get: vi.fn(async (key: string) => store.get(key) ?? null),
            setWithTtl: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
        };
        service = new SlaReportService({ aggregate } as never, cache as never);
    });

    afterEach(() => { vi.restoreAllMocks(); });

    describe('without a cached entry', () => {
        it('computes the report from PostgreSQL and stores it for ten minutes under the key of the parameters', async () => {
            const report = await service.aggregate(FROM, TO, SlaGroupBy.ZONE);

            expect(aggregate).toHaveBeenCalledWith(SlaGroupBy.ZONE, FROM, TO);
            expect(report).toMatchObject({ from: FROM, to: TO, groupBy: 'zone' });
            expect(report.rows).toHaveLength(1);
            expect(report.totals).toMatchObject({ closedCount: 5, deliveredCount: 4, onTimePercentage: 75, averageDelayMinutes: 20, averageCycleMinutes: 100, incidentCount: 2 });
            expect(cache.setWithTtl).toHaveBeenCalledTimes(1);
            expect(cache.setWithTtl).toHaveBeenCalledWith(KEY(SlaGroupBy.ZONE), JSON.stringify(report), 600);
            expect(warn).not.toHaveBeenCalled();
        });

        it('stores an empty report too (nothing closed in the range)', async () => {
            aggregate.mockResolvedValue([]);
            const report = await service.aggregate(FROM, TO, SlaGroupBy.DRIVER);
            expect(report.rows).toEqual([]);
            expect(cache.setWithTtl).toHaveBeenCalledTimes(1);
        });
    });

    describe('with a cached entry', () => {
        it('serves it without touching PostgreSQL, and a second call does not recompute', async () => {
            const first = await service.aggregate(FROM, TO, SlaGroupBy.ZONE);
            aggregate.mockClear();
            aggregate.mockResolvedValue([sums({ closedCount: 99, deliveredCount: 99, onTimeCount: 99, lateCount: 0 })]);

            const second = await service.aggregate(FROM, TO, SlaGroupBy.ZONE);

            expect(second).toEqual(first);
            expect(aggregate).not.toHaveBeenCalled();
            expect(cache.setWithTtl).toHaveBeenCalledTimes(1);
        });

        it('keeps one entry per grouping and per range', async () => {
            await service.aggregate(FROM, TO, SlaGroupBy.ZONE);
            await service.aggregate(FROM, TO, SlaGroupBy.DRIVER);
            await service.aggregate(FROM, '2026-10-30', SlaGroupBy.ZONE);

            expect(aggregate).toHaveBeenCalledTimes(3);
            expect([...store.keys()].sort()).toEqual([KEY(SlaGroupBy.DRIVER), KEY(SlaGroupBy.ZONE), KEY(SlaGroupBy.ZONE, FROM, '2026-10-30')].sort());
        });

        it.each([
            ['is not JSON', 'not json'],
            ['is not a report', JSON.stringify({ hello: 'world' })],
            ['is the report of another range', JSON.stringify({ from: '2026-09-01', to: TO, groupBy: 'zone', totals: {}, rows: [] })],
        ])('recomputes and overwrites an entry that %s, with a warning', async (_name, raw) => {
            store.set(KEY(SlaGroupBy.ZONE), raw);

            const report = await service.aggregate(FROM, TO, SlaGroupBy.ZONE);

            expect(aggregate).toHaveBeenCalledTimes(1);
            expect(report.rows).toHaveLength(1);
            expect(store.get(KEY(SlaGroupBy.ZONE))).toBe(JSON.stringify(report));
            expect(warn).toHaveBeenCalledTimes(1);
        });

        it('recomputes an entry with impossible figures', async () => {
            const good = await service.aggregate(FROM, TO, SlaGroupBy.ZONE);
            store.set(KEY(SlaGroupBy.ZONE), JSON.stringify({ ...good, totals: { ...good.totals, deliveredCount: 999 } }));
            aggregate.mockClear();

            await service.aggregate(FROM, TO, SlaGroupBy.ZONE);

            expect(aggregate).toHaveBeenCalledTimes(1);
        });
    });

    describe('when Redis fails', () => {
        it('answers from PostgreSQL when the read fails, and still tries to store', async () => {
            cache.get.mockRejectedValue(new Error('Redis down'));

            const report = await service.aggregate(FROM, TO, SlaGroupBy.SERVICE_LEVEL);

            expect(aggregate).toHaveBeenCalledTimes(1);
            expect(report.groupBy).toBe('service_level');
            expect(cache.setWithTtl).toHaveBeenCalledTimes(1);
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('Could not read the SLA report cache'));
        });

        it('answers the report when the write fails', async () => {
            cache.setWithTtl.mockRejectedValue(new Error('Redis down'));

            const report = await service.aggregate(FROM, TO, SlaGroupBy.ZONE);

            expect(report.rows).toHaveLength(1);
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('Could not store the SLA report in the cache'));
        });

        it('answers from PostgreSQL when Redis fails in both the read and the write', async () => {
            cache.get.mockRejectedValue(new Error('Redis down'));
            cache.setWithTtl.mockRejectedValue(new Error('Redis down'));

            await expect(service.aggregate(FROM, TO, SlaGroupBy.DRIVER)).resolves.toMatchObject({ groupBy: 'driver' });
            expect(warn).toHaveBeenCalledTimes(2);
        });
    });

    describe('range', () => {
        it('rejects a `from` after the `to` before touching Redis or PostgreSQL', async () => {
            await expect(service.aggregate('2026-10-31', '2026-10-01', SlaGroupBy.ZONE)).rejects.toThrow(InvalidHistoryDateRangeException);
            expect(cache.get).not.toHaveBeenCalled();
            expect(aggregate).not.toHaveBeenCalled();
        });

        it('rejects a range above 366 days before touching Redis or PostgreSQL', async () => {
            await expect(service.aggregate('2025-01-01', '2026-10-31', SlaGroupBy.ZONE)).rejects.toThrow(SlaRangeTooLargeException);
            expect(cache.get).not.toHaveBeenCalled();
            expect(aggregate).not.toHaveBeenCalled();
        });
    });

    describe('when PostgreSQL fails', () => {
        it('lets the error out and stores nothing', async () => {
            aggregate.mockRejectedValue(new Error('db down'));

            await expect(service.aggregate(FROM, TO, SlaGroupBy.ZONE)).rejects.toThrow('db down');
            expect(cache.setWithTtl).not.toHaveBeenCalled();
        });
    });

    describe('compute', () => {
        it('goes straight to PostgreSQL, ignoring a cached entry and writing nothing', async () => {
            await service.aggregate(FROM, TO, SlaGroupBy.ZONE);
            cache.get.mockClear();
            cache.setWithTtl.mockClear();
            aggregate.mockClear();

            await service.compute(FROM, TO, SlaGroupBy.ZONE);

            expect(aggregate).toHaveBeenCalledTimes(1);
            expect(cache.get).not.toHaveBeenCalled();
            expect(cache.setWithTtl).not.toHaveBeenCalled();
        });

        it('also validates the range', async () => {
            await expect(service.compute('2026-10-31', '2026-10-01', SlaGroupBy.ZONE)).rejects.toThrow(InvalidHistoryDateRangeException);
            expect(aggregate).not.toHaveBeenCalled();
        });
    });
});
