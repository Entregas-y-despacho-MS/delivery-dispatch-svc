import { describe, expect, it, vi } from 'vitest';
import { CacheUnavailableException } from '../../../plugins/cache/exceptions/index.js';
import { OsrmRequestException, OsrmTableTooBigException, OsrmUnavailableException } from '../../../plugins/osrm/exceptions/index.js';
import { FakeOsrm } from '../../planning/domain/plan-fixtures.helper-spec.js';
import { ETA_CACHE_PREFIX, TrackingEtaService, type EtaSubject } from './tracking-eta.service.js';

const NOW = new Date('2026-11-05T14:00:00Z');
const LATER = new Date('2026-11-05T14:00:30Z');
const WINDOW_END = new Date('2026-11-05T15:30:00Z');

// The OSRM double drives 0.01 degrees (1 km) in 60 s.
const DRIVER = { last_latitude: '0.000000', last_longitude: '0.000000' };
const stop = (id: number, km: number | null) => ({
    dispatch_id: id,
    delivery_latitude: km === null ? null : String(-km * 0.01),
    delivery_longitude: km === null ? null : '0.000000',
});

function subject(overrides: Partial<EtaSubject> = {}): EtaSubject {
    return { dispatchId: 30, status: 'out_for_delivery', routeBatchId: 500, windowEnd: WINDOW_END, ...overrides };
}

interface Options {
    position?: unknown[];
    stops?: unknown[];
    cache?: Partial<Record<'get' | 'setWithTtl', (...args: any[]) => Promise<any>>>;
}

function setup({ position = [DRIVER], stops = [stop(10, 2), stop(30, 5)], cache = {} }: Options = {}) {
    const query = vi.fn(async (sql: string) => (sql.includes('ORDER BY last_location_at') ? position : stops));
    const osrm = new FakeOsrm();
    const store = new Map<string, { value: string; ttl: number }>();
    const get = vi.fn(cache.get ?? (async (key: string) => store.get(key)?.value ?? null));
    const setWithTtl = vi.fn(cache.setWithTtl ?? (async (key: string, value: string, ttl: number) => { store.set(key, { value, ttl }); }));
    const service = new TrackingEtaService({ query } as any, osrm, { get, setWithTtl } as any);
    return { service, query, osrm, get, setWithTtl, store };
}

describe('TrackingEtaService', () => {
    describe('the estimate with OSRM', () => {
        it('drives from the last position through the pending stops before this order to the customer', async () => {
            const { service, osrm } = setup(); // driver -> 2 km -> 5 km: 120 s + 180 s

            const eta = await service.estimate(subject(), NOW);

            expect(eta).toEqual({ minutes: 5, calculatedAt: NOW, source: 'osrm' });
            expect(osrm.calls).toEqual([[
                { lat: 0, lon: 0 },
                { lat: -0.02, lon: 0 },
                { lat: -0.05, lon: 0 },
            ]]);
        });

        it('asks OSRM once, with a single matrix, however many stops come first', async () => {
            const { service, osrm } = setup({ stops: [stop(10, 1), stop(11, 2), stop(12, 3), stop(30, 4)] });

            const eta = await service.estimate(subject(), NOW); // 4 legs of 1 km = 240 s

            expect(osrm.calls).toHaveLength(1);
            expect(osrm.calls[0]).toHaveLength(5);
            expect(eta?.minutes).toBe(4);
        });

        it('goes straight to the customer when it is the next stop (in_transit)', async () => {
            const { service, osrm } = setup({ stops: [stop(30, 3)] });

            const eta = await service.estimate(subject({ status: 'in_transit' }), NOW);

            expect(eta).toEqual({ minutes: 3, calculatedAt: NOW, source: 'osrm' });
            expect(osrm.calls[0]).toEqual([{ lat: 0, lon: 0 }, { lat: -0.03, lon: 0 }]);
        });

        it('rounds the minutes up', async () => {
            const { service } = setup({ stops: [{ ...stop(30, 0), delivery_latitude: '-0.0101' }] }); // 61 s

            expect((await service.estimate(subject(), NOW))?.minutes).toBe(2);
        });

        it('skips a previous stop without coordinates', async () => {
            const { service, osrm } = setup({ stops: [stop(10, null), stop(30, 2)] });

            await service.estimate(subject(), NOW);

            expect(osrm.calls[0]).toEqual([{ lat: 0, lon: 0 }, { lat: -0.02, lon: 0 }]);
        });

        it('reads the position of the whole route, the newest one, and the stops still pending up to this order', async () => {
            const { service, query } = setup();

            await service.estimate(subject(), NOW);

            const [positionSql, positionParams] = query.mock.calls[0] as unknown as [string, unknown[]];
            expect(positionSql).toContain('route_batch_id = $1');
            expect(positionSql).toMatch(/ORDER BY last_location_at DESC\s+LIMIT 1/);
            expect(positionParams).toEqual([500]);
            const [stopsSql, stopsParams] = query.mock.calls[1] as unknown as [string, unknown[]];
            expect(stopsSql).toContain('d.sequence_order <=');
            expect(stopsSql).toContain('ORDER BY d.sequence_order');
            expect(stopsParams).toEqual([500, 30, 'out_for_delivery', 'in_transit']);
        });
    });

    describe('states with nothing to estimate', () => {
        it.each(['pending', 'scheduled', 'assigned', 'delivered', 'not_delivered', 'incident', 'cancelled', 'rescheduled'])(
            'is null for %s and touches neither the database, OSRM nor the cache',
            async (status) => {
                const { service, query, osrm, get, setWithTtl } = setup();

                expect(await service.estimate(subject({ status }), NOW)).toBeNull();

                expect(query).not.toHaveBeenCalled();
                expect(osrm.calls).toHaveLength(0);
                expect(get).not.toHaveBeenCalled();
                expect(setWithTtl).not.toHaveBeenCalled();
            },
        );

        it('is null when the order has no route', async () => {
            const { service, query } = setup();

            expect(await service.estimate(subject({ routeBatchId: null }), NOW)).toBeNull();
            expect(query).not.toHaveBeenCalled();
        });
    });

    describe('when OSRM cannot give the estimate: the promised slot instead, never an error', () => {
        const slot = { minutes: 90, calculatedAt: NOW, source: 'window' };

        it('OSRM does not answer (503)', async () => {
            const { service, osrm } = setup();
            osrm.failWith = new OsrmUnavailableException(5000, 'timeout');

            expect(await service.estimate(subject(), NOW)).toEqual(slot);
        });

        it('OSRM answers with a request error or a table too big', async () => {
            for (const error of [new OsrmRequestException('NoRoute'), new OsrmTableTooBigException('TooBig')]) {
                const { service, osrm } = setup();
                osrm.failWith = error;

                expect(await service.estimate(subject(), NOW)).toEqual(slot);
            }
        });

        it('rethrows what is not an OSRM failure, so a bug is not hidden as a slot', async () => {
            const { service, osrm } = setup();
            osrm.failWith = new TypeError('bug');

            await expect(service.estimate(subject(), NOW)).rejects.toThrow('bug');
        });

        it('there is no route between two of the points', async () => {
            const { service, osrm } = setup();
            osrm.getDurationMatrix = async () => ({ durations: [[0, 100, null], [100, 0, null], [null, null, 0]] });

            expect(await service.estimate(subject(), NOW)).toEqual(slot);
        });

        it('the route has not reported any position yet, without calling OSRM', async () => {
            const { service, osrm } = setup({ position: [] });

            expect(await service.estimate(subject(), NOW)).toEqual(slot);
            expect(osrm.calls).toHaveLength(0);
        });

        it('the address of the customer has no coordinates, without calling OSRM', async () => {
            const { service, osrm } = setup({ stops: [stop(10, 2), stop(30, null)] });

            expect(await service.estimate(subject(), NOW)).toEqual(slot);
            expect(osrm.calls).toHaveLength(0);
        });

        it('this order is not among the pending stops of its route', async () => {
            const { service, osrm } = setup({ stops: [stop(10, 2)] });

            expect(await service.estimate(subject(), NOW)).toEqual(slot);
            expect(osrm.calls).toHaveLength(0);
        });

        it('counts down to the end of the slot and stops at zero once it is over', async () => {
            const down = setup({ position: [] });
            expect((await down.service.estimate(subject({ windowEnd: new Date('2026-11-05T14:10:30Z') }), NOW))?.minutes).toBe(11);

            const late = setup({ position: [] });
            expect((await late.service.estimate(subject({ windowEnd: new Date('2026-11-05T13:00:00Z') }), NOW))?.minutes).toBe(0);
        });

        it('has nothing to show when there is no estimate and no slot either, and caches nothing', async () => {
            const { service, setWithTtl } = setup({ position: [] });

            expect(await service.estimate(subject({ windowEnd: null }), NOW)).toBeNull();
            expect(setWithTtl).not.toHaveBeenCalled();
        });
    });

    describe('the cache of 60 seconds per delivery', () => {
        it('stores the estimate under the key of the delivery for 60 seconds', async () => {
            const { service, setWithTtl, store } = setup();

            await service.estimate(subject(), NOW);

            expect(setWithTtl).toHaveBeenCalledTimes(1);
            expect(setWithTtl).toHaveBeenCalledWith(`${ETA_CACHE_PREFIX}30`, expect.any(String), 60);
            expect(ETA_CACHE_PREFIX).toBe('tracking:eta:');
            expect(JSON.parse(store.get('tracking:eta:30')!.value)).toEqual({ minutes: 5, calculatedAt: NOW.toISOString(), source: 'osrm' });
        });

        it('answers the next request from the cache: no database, no OSRM, the same calculatedAt as a Date', async () => {
            const { service, query, osrm } = setup();
            const first = await service.estimate(subject(), NOW);
            query.mockClear();

            const second = await service.estimate(subject(), LATER);

            expect(second).toEqual(first);
            expect(second?.calculatedAt).toBeInstanceOf(Date);
            expect(second?.calculatedAt).toEqual(NOW);
            expect(query).not.toHaveBeenCalled();
            expect(osrm.calls).toHaveLength(1);
        });

        it('keeps one estimate per delivery', async () => {
            const { service, store } = setup(); // dispatch 31 is not among the stops returned: it gets its own (window) entry

            const own = await service.estimate(subject({ dispatchId: 30 }), NOW);
            const other = await service.estimate(subject({ dispatchId: 31 }), NOW);

            expect(own?.source).toBe('osrm');
            expect(other?.source).toBe('window');
            expect([...store.keys()].sort()).toEqual(['tracking:eta:30', 'tracking:eta:31']);
        });

        it('also keeps the slot while OSRM is down, so the page does not wait for the timeout on every refresh', async () => {
            const { service, osrm, setWithTtl } = setup();
            osrm.failWith = new OsrmUnavailableException(5000);

            const first = await service.estimate(subject(), NOW);
            const second = await service.estimate(subject(), LATER);

            expect(first?.source).toBe('window');
            expect(second).toEqual(first);
            expect(osrm.calls).toHaveLength(1);
            expect(setWithTtl).toHaveBeenCalledTimes(1);
        });

        it('calculates again when the entry is gone (the 60 seconds are over)', async () => {
            const { service, osrm, store } = setup();
            await service.estimate(subject(), NOW);
            store.clear();

            await service.estimate(subject(), LATER);

            expect(osrm.calls).toHaveLength(2);
        });

        it('ignores an entry it did not write: not JSON, wrong shape, unknown source, invalid date or negative minutes', async () => {
            const garbage = [
                'not json',
                '{}',
                JSON.stringify({ minutes: '5', calculatedAt: NOW.toISOString(), source: 'osrm' }),
                JSON.stringify({ minutes: 5, calculatedAt: NOW.toISOString(), source: 'guess' }),
                JSON.stringify({ minutes: 5, calculatedAt: 'yesterday-ish', source: 'osrm' }),
                JSON.stringify({ minutes: -1, calculatedAt: NOW.toISOString(), source: 'osrm' }),
            ];
            for (const value of garbage) {
                const { service, osrm } = setup({ cache: { get: async () => value } });

                expect((await service.estimate(subject(), NOW))?.source).toBe('osrm');
                expect(osrm.calls).toHaveLength(1);
            }
        });

        it('calculates without the cache when it is down on reading, and still answers', async () => {
            const { service, osrm } = setup({ cache: { get: async () => { throw new CacheUnavailableException(); } } });

            expect(await service.estimate(subject(), NOW)).toEqual({ minutes: 5, calculatedAt: NOW, source: 'osrm' });
            expect(osrm.calls).toHaveLength(1);
        });

        it('answers even when the cache is down on writing', async () => {
            const { service } = setup({ cache: { setWithTtl: async () => { throw new CacheUnavailableException(); } } });

            expect(await service.estimate(subject(), NOW)).toEqual({ minutes: 5, calculatedAt: NOW, source: 'osrm' });
        });

        it('does not hide a failure of the cache that is not "unavailable"', async () => {
            const reading = setup({ cache: { get: async () => { throw new TypeError('bug'); } } });
            await expect(reading.service.estimate(subject(), NOW)).rejects.toThrow('bug');

            const writing = setup({ cache: { setWithTtl: async () => { throw new TypeError('bug'); } } });
            await expect(writing.service.estimate(subject(), NOW)).rejects.toThrow('bug');
        });
    });
});
