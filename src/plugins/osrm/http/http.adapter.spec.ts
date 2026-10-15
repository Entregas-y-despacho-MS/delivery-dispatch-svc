import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { OsrmHttpAdapter } from './http.adapter.js';
import { Coordinate } from '../osrm.port.js';
import {
    OsrmRequestException,
    OsrmTableTooBigException,
    OsrmUnavailableException,
} from '../exceptions/index.js';

const BASE = 'http://osrm.test';

function makeAdapter(overrides: Partial<{ tableMaxCoordinates: number; timeoutMs: number }> = {}) {
    return new OsrmHttpAdapter({
        baseUrl: BASE,
        tableMaxCoordinates: 100,
        timeoutMs: 5000,
        ...overrides,
    } as any);
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Deterministic "driving time": depends on both points, and is asymmetric like a one-way street. */
function fakeSeconds(a: Coordinate, b: Coordinate): number {
    return Math.round(Math.abs(a.lat - b.lat) * 10_000 + Math.abs(a.lon - b.lon) * 20_000 + (a.lat > b.lat ? 7 : 0));
}

/** Parses a /table URL the way OSRM does and answers with the matching sub-matrix. */
function tableServer(opts: { maxCoords?: number } = {}) {
    const calls: { coordinates: Coordinate[]; sources: number[]; destinations: number[] }[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        const coordinates = url.pathname
            .split('/')
            .pop()!
            .split(';')
            .map((pair) => {
                const [lon, lat] = pair.split(',').map(Number);
                return { lat, lon };
            });
        const explicit = url.searchParams.has('sources');
        const indexes = (key: string) =>
            url.searchParams.has(key) ? url.searchParams.get(key)!.split(';').map(Number) : coordinates.map((_, i) => i);
        const sources = indexes('sources');
        const destinations = indexes('destinations');
        calls.push({ coordinates, sources, destinations });

        const max = opts.maxCoords ?? 100;
        const tooBig = explicit
            ? sources.length * destinations.length > max * max
            : coordinates.length > max;
        if (tooBig) return jsonResponse({ code: 'TooBig', message: 'Too many table coordinates' }, 400);

        return jsonResponse({
            code: 'Ok',
            durations: sources.map((s) => destinations.map((d) => (s === d ? 0 : fakeSeconds(coordinates[s], coordinates[d])))),
        });
    });
    return { fetchMock, calls };
}

describe('OsrmHttpAdapter', () => {
    beforeEach(() => {
        vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    describe('getDurationMatrix', () => {
        it('asks /table with lon,lat order and returns the durations', async () => {
            const fetchMock = vi.fn(async () =>
                jsonResponse({ code: 'Ok', durations: [[0, 120.5, 300], [110, 0, 95], [290, 80, 0]] }),
            );
            vi.stubGlobal('fetch', fetchMock);

            const result = await makeAdapter().getDurationMatrix([
                { lat: -16.5, lon: -68.1 },
                { lat: -16.51, lon: -68.12 },
                { lat: -16.52, lon: -68.13 },
            ]);

            expect(result.durations).toEqual([[0, 120.5, 300], [110, 0, 95], [290, 80, 0]]);
            const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
            expect(url).toBe(
                `${BASE}/table/v1/driving/-68.1,-16.5;-68.12,-16.51;-68.13,-16.52?annotations=duration`,
            );
            expect(init.signal).toBeInstanceOf(AbortSignal);
        });

        it('keeps null when OSRM finds no route between a pair', async () => {
            vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 'Ok', durations: [[0, null], [50, 0]] })));

            const result = await makeAdapter().getDurationMatrix([
                { lat: -16.5, lon: -68.1 },
                { lat: -16.6, lon: -68.2 },
            ]);

            expect(result.durations).toEqual([[0, null], [50, 0]]);
        });

        it('does not call OSRM for zero or one coordinate', async () => {
            const fetchMock = vi.fn();
            vi.stubGlobal('fetch', fetchMock);
            const adapter = makeAdapter();

            await expect(adapter.getDurationMatrix([])).resolves.toEqual({ durations: [] });
            await expect(adapter.getDurationMatrix([{ lat: -16.5, lon: -68.1 }])).resolves.toEqual({ durations: [[0]] });
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('answers 503 OSRM_UNAVAILABLE when OSRM does not answer within the timeout', async () => {
            vi.stubGlobal('fetch', vi.fn(async () => {
                throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
            }));

            const error = await makeAdapter()
                .getDurationMatrix([{ lat: -16.5, lon: -68.1 }, { lat: -16.6, lon: -68.2 }])
                .catch((e) => e);

            expect(error).toBeInstanceOf(OsrmUnavailableException);
            expect(error.getStatus()).toBe(503);
            expect(error.getResponse()).toMatchObject({ error: 'OSRM_UNAVAILABLE' });
            expect(error.getResponse().message).toContain('5 s');
        });

        it('really aborts a request that exceeds timeoutMs', async () => {
            // A fetch that only finishes when its signal fires, like a hung socket.
            vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_, reject) => {
                init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
            })));

            await expect(
                makeAdapter({ timeoutMs: 20 }).getDurationMatrix([{ lat: -16.5, lon: -68.1 }, { lat: -16.6, lon: -68.2 }]),
            ).rejects.toBeInstanceOf(OsrmUnavailableException);
        });

        it('answers 503 on a network error', async () => {
            vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));

            await expect(
                makeAdapter().getDurationMatrix([{ lat: -16.5, lon: -68.1 }, { lat: -16.6, lon: -68.2 }]),
            ).rejects.toBeInstanceOf(OsrmUnavailableException);
        });

        it('answers 503 when OSRM answers HTTP 5xx', async () => {
            vi.stubGlobal('fetch', vi.fn(async () => new Response('Bad Gateway', { status: 502 })));

            await expect(
                makeAdapter().getDurationMatrix([{ lat: -16.5, lon: -68.1 }, { lat: -16.6, lon: -68.2 }]),
            ).rejects.toBeInstanceOf(OsrmUnavailableException);
        });

        it('throws OsrmTableTooBigException (internal, not 503) when OSRM answers TooBig', async () => {
            vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 'TooBig', message: 'x' }, 400)));

            const error = await makeAdapter()
                .getDurationMatrix([{ lat: -16.5, lon: -68.1 }, { lat: -16.6, lon: -68.2 }])
                .catch((e) => e);

            expect(error).toBeInstanceOf(OsrmTableTooBigException);
            expect(error).not.toBeInstanceOf(OsrmUnavailableException);
        });

        it('keeps a non-recoverable OSRM code as OsrmRequestException (500)', async () => {
            vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 'InvalidQuery', message: 'x' }, 400)));

            await expect(
                makeAdapter().getDurationMatrix([{ lat: -16.5, lon: -68.1 }, { lat: -16.6, lon: -68.2 }]),
            ).rejects.toBeInstanceOf(OsrmRequestException);
        });

        it('rejects a matrix whose shape is not the one asked for', async () => {
            vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 'Ok', durations: [[0, 1]] })));

            await expect(
                makeAdapter().getDurationMatrix([{ lat: -16.5, lon: -68.1 }, { lat: -16.6, lon: -68.2 }]),
            ).rejects.toBeInstanceOf(OsrmRequestException);
        });

        describe('when there are more coordinates than the limit', () => {
            const points: Coordinate[] = Array.from({ length: 7 }, (_, i) => ({
                lat: -16.5 - i * 0.013 + (i % 2) * 0.004,
                lon: -68.1 - i * 0.009 - (i % 3) * 0.002,
            }));

            it('splits into blocks and rebuilds the same matrix as a single call', async () => {
                const server = tableServer({ maxCoords: 3 });
                vi.stubGlobal('fetch', server.fetchMock);

                const split = await makeAdapter({ tableMaxCoordinates: 3 }).getDurationMatrix(points);

                const expected = points.map((a, i) => points.map((b, j) => (i === j ? 0 : fakeSeconds(a, b))));
                expect(split.durations).toEqual(expected);

                // 7 coordinates in blocks of 3 → ceil(7/3)² = 9 requests.
                expect(server.fetchMock).toHaveBeenCalledTimes(9);
                for (const call of server.calls) {
                    expect(call.sources.length * call.destinations.length).toBeLessThanOrEqual(9);
                    expect(call.coordinates.length).toBeLessThanOrEqual(6);
                }
            });

            it('does not split when the coordinates fit the limit', async () => {
                const server = tableServer({ maxCoords: 7 });
                vi.stubGlobal('fetch', server.fetchMock);

                await makeAdapter({ tableMaxCoordinates: 7 }).getDurationMatrix(points);

                expect(server.fetchMock).toHaveBeenCalledTimes(1);
            });
        });
    });

    describe('getRoute', () => {
        it('shares the timeout and the 503 translation with every other call', async () => {
            vi.stubGlobal('fetch', vi.fn(async () => {
                throw new DOMException('timeout', 'TimeoutError');
            }));

            await expect(
                makeAdapter().getRoute({ lat: -16.5, lon: -68.1 }, { lat: -16.6, lon: -68.2 }),
            ).rejects.toBeInstanceOf(OsrmUnavailableException);
        });

        it('keeps returning distance and duration', async () => {
            vi.stubGlobal('fetch', vi.fn(async () =>
                jsonResponse({ code: 'Ok', routes: [{ distance: 8997.6, duration: 743.2 }] }),
            ));

            await expect(
                makeAdapter().getRoute({ lat: -16.5, lon: -68.1 }, { lat: -16.6, lon: -68.2 }),
            ).resolves.toEqual({ distanceMeters: 8997.6, durationSeconds: 743.2 });
        });
    });
});
