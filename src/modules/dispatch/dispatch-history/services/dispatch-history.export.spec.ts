import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { DispatchHistoryService, EXPORT_BATCH_SIZE } from './dispatch-history.service.js';
import { InvalidHistoryDateRangeException } from '../exceptions/index.js';
import { ExportDispatchHistoryParamsDto } from '../dto/find-dispatch-history-params.dto.js';

const HEADER = '﻿Código de traslado,Cliente,Repartidor,Vehículo,Hora de partida,Hora de entrega,Estado\r\n';

const params = (overrides: Partial<ExportDispatchHistoryParamsDto> = {}): ExportDispatchHistoryParamsDto =>
    Object.assign(new ExportDispatchHistoryParamsDto(), overrides);

const row = (id: number, overrides: Record<string, unknown> = {}) => ({
    id, tracking_code: `DSP-2026-${String(id).padStart(5, '0')}`, recipient: 'María', driver_id: 7, driver_name: 'Juan', plate: '1234ABC',
    status: 'delivered', closed_at: new Date('2026-10-10T15:00:00.000Z'), ...overrides,
});

/** A query runner that answers DECLARE, the FETCH batches in order and the departures lookup. */
function setup(batches: unknown[][], options: { declareError?: Error; departures?: unknown[] } = {}) {
    const fetches = [...batches];
    const manager = { query: vi.fn().mockResolvedValue(options.departures ?? []) };
    const runner = {
        connect: vi.fn().mockResolvedValue(undefined),
        startTransaction: vi.fn().mockResolvedValue(undefined),
        rollbackTransaction: vi.fn().mockResolvedValue(undefined),
        release: vi.fn().mockResolvedValue(undefined),
        isTransactionActive: true,
        manager,
        query: vi.fn(async (sql: string) => {
            if (sql.startsWith('DECLARE')) {
                if (options.declareError) throw options.declareError;
                return undefined;
            }
            return fetches.shift() ?? [];
        }),
    };
    const dataSource = { createQueryRunner: vi.fn(() => runner), query: vi.fn() };
    return { service: new DispatchHistoryService(dataSource as never), runner, manager, dataSource };
}

async function read(stream: Readable): Promise<string> {
    let text = '';
    for await (const chunk of stream) text += chunk;
    return text;
}

describe('DispatchHistoryService.exportCsv', () => {
    it('validates the filters before sending anything: a bad range throws right away, with no connection taken', () => {
        const { service, dataSource } = setup([]);

        expect(() => service.exportCsv(params({ from: '2026-10-06', to: '2026-10-05' }))).toThrow(InvalidHistoryDateRangeException);
        expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    });

    it('writes the BOM, the header row and one line per dispatch, with CRLF line ends', async () => {
        const { service } = setup([[row(1), row(2, { status: 'not_delivered', driver_id: null, driver_name: null, plate: null })]], {
            departures: [{ dispatch_id: 1, departed_at: '2026-10-10T13:00:00.000Z', event_at: new Date('2026-10-10T13:00:01.000Z') }],
        });

        const csv = await read(service.exportCsv(params()));

        expect(csv).toBe(
            HEADER
            + 'DSP-2026-00001,María,Juan,1234ABC,2026-10-10T09:00:00-04:00,2026-10-10T11:00:00-04:00,delivered\r\n'
            + 'DSP-2026-00002,María,,,,,not_delivered\r\n',
        );
    });

    it('escapes commas, quotes and formulas in the free-text cells', async () => {
        const { service } = setup([[row(1, { recipient: 'Pérez, "Ana"', driver_name: '=1+1' })]]);

        const csv = await read(service.exportCsv(params()));

        expect(csv).toContain(`DSP-2026-00001,"Pérez, ""Ana""",'=1+1,1234ABC,`);
    });

    it('reads the history in batches until the cursor runs out, and looks up the departures once per batch', async () => {
        const first = Array.from({ length: EXPORT_BATCH_SIZE }, (_, i) => row(i + 1));
        const second = [row(EXPORT_BATCH_SIZE + 1)];
        const { service, runner, manager } = setup([first, second]);

        const csv = await read(service.exportCsv(params()));

        expect(csv.split('\r\n').filter(Boolean)).toHaveLength(1 + EXPORT_BATCH_SIZE + 1);
        const fetches = runner.query.mock.calls.filter(([sql]) => String(sql).startsWith('FETCH'));
        expect(fetches).toHaveLength(2);
        expect(manager.query).toHaveBeenCalledTimes(2);
    });

    it('asks once more when a batch is exactly full, and stops on the empty one', async () => {
        const { service, runner } = setup([Array.from({ length: EXPORT_BATCH_SIZE }, (_, i) => row(i + 1)), []]);

        await read(service.exportCsv(params()));

        expect(runner.query.mock.calls.filter(([sql]) => String(sql).startsWith('FETCH'))).toHaveLength(2);
    });

    it('with no matching dispatch the file still has its header row', async () => {
        const { service } = setup([[]]);

        expect(await read(service.exportCsv(params()))).toBe(HEADER);
    });

    it('declares the cursor with the same filters, sort and bound values as the listing', async () => {
        const { service, runner } = setup([[]]);

        await read(service.exportCsv(params({ from: '2026-10-01', driverId: 7, status: 'delivered' as never })));

        const [sql, args] = runner.query.mock.calls[0];
        expect(sql).toMatch(/^DECLARE dispatch_history_export NO SCROLL CURSOR FOR SELECT/);
        expect(sql).toContain('rb.driver_id = $2');
        expect(sql).toContain('ORDER BY d.closed_at DESC, d.dispatch_id DESC');
        expect(args).toEqual(['2026-10-01', 7, 'delivered']);
    });

    it('does not take a connection until the stream is read', () => {
        const { service, dataSource } = setup([[]]);

        service.exportCsv(params());

        expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    });

    it('closes the transaction and gives the connection back when the file is complete', async () => {
        const { service, runner } = setup([[row(1)]]);

        await read(service.exportCsv(params()));

        expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
        expect(runner.release).toHaveBeenCalledTimes(1);
    });

    it('gives the connection back when the client leaves halfway', async () => {
        const { service, runner } = setup([Array.from({ length: EXPORT_BATCH_SIZE }, (_, i) => row(i + 1)), [row(EXPORT_BATCH_SIZE + 1)]]);
        const stream = service.exportCsv(params());

        for await (const _chunk of stream) break; // the consumer stops after the first chunk

        // Node returns the generator asynchronously once the stream is destroyed: its `finally` runs a moment later.
        await vi.waitFor(() => expect(runner.release).toHaveBeenCalledTimes(1));
        expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
        // It does not keep reading the whole history for a client that left: at most one batch of read-ahead.
        const batchesRead = runner.query.mock.calls.filter(([sql]) => String(sql).startsWith('FETCH')).length;
        expect(batchesRead).toBeLessThanOrEqual(2);
    });

    it('if the database fails before the first batch, nothing is written, the stream errors and the connection is released', async () => {
        const { service, runner } = setup([], { declareError: new Error('relation does not exist') });
        const chunks: string[] = [];

        await expect((async () => { for await (const chunk of service.exportCsv(params())) chunks.push(chunk); })()).rejects.toThrow('relation does not exist');

        expect(chunks).toEqual([]);
        expect(runner.release).toHaveBeenCalledTimes(1);
    });
});
