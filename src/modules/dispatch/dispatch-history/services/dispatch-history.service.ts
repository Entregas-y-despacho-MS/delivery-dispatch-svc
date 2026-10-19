import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Readable } from 'node:stream';
import { DispatchStatusEnum } from '../../../../shared/enums/dispatch-status.enum.js';
import { DispatchHistoryItemDto, FindDispatchHistoryResponseDto } from '../dto/dispatch-history.dto.js';
import { ExportDispatchHistoryParamsDto, FindDispatchHistoryParamsDto } from '../dto/find-dispatch-history-params.dto.js';
import { CSV_BOM, csvLine, formatLocalIso } from '../utils/csv.js';
import { buildHistoryQuery, HISTORY_FROM_SQL } from '../utils/history-query.js';

interface HistoryRow {
    id: number;
    tracking_code: string | null;
    recipient: string | null;
    driver_id: number | null;
    driver_name: string | null;
    plate: string | null;
    status: string;
    closed_at: Date;
}

interface DepartureRow {
    dispatch_id: number;
    departed_at: string | null;
    event_at: Date;
}

const ROW_SELECT_SQL = `SELECT d.dispatch_id AS id, d.tracking_code, d.contact_name AS recipient,
                    rb.driver_id, u.full_name AS driver_name, v.plate, s.name AS status, d.closed_at`;

/** Rows the export reads from the cursor at a time: bounds the memory used however large the history is. */
export const EXPORT_BATCH_SIZE = 500;

export const CSV_HEADER = ['Código de traslado', 'Cliente', 'Repartidor', 'Vehículo', 'Hora de partida', 'Hora de entrega', 'Estado'];

/**
 * ST-55.2 / RF-A08 — history of dispatches that reached a terminal status, with combined filters and
 * server-side pagination. Parameterized SQL with a whitelist for the sort, like the pending-orders inbox.
 */
@Injectable()
export class DispatchHistoryService {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    async findAll(params: FindDispatchHistoryParamsDto): Promise<FindDispatchHistoryResponseDto> {
        const { page, limit } = params;
        const { whereSql, orderSql, args, bind } = buildHistoryQuery(params);

        const [{ total }]: { total: number }[] = await this.dataSource.query(
            `SELECT COUNT(*)::int AS total ${HISTORY_FROM_SQL} ${whereSql}`,
            args,
        );

        const rows: HistoryRow[] = await this.dataSource.query(
            `${ROW_SELECT_SQL}
             ${HISTORY_FROM_SQL} ${whereSql} ${orderSql}
             LIMIT ${bind(limit)} OFFSET ${bind((page - 1) * limit)}`,
            args,
        );

        const departures = await this.findDepartures(rows.map((row) => row.id));
        return { data: rows.map((row) => this.toDto(row, departures.get(row.id) ?? null)), total, page, limit };
    }

    /**
     * The whole history that matches the filters, as CSV and without pagination. The filters and the sort are
     * validated right here, before the first byte, so a bad request still answers 400; the rows are read later,
     * as the client consumes the stream.
     */
    exportCsv(params: ExportDispatchHistoryParamsDto): Readable {
        const query = buildHistoryQuery(params);
        // One chunk of read-ahead (a batch of rows): by default Node would read up to 16 batches before the client asks.
        return Readable.from(this.generateCsv(query.whereSql, query.orderSql, query.args), { highWaterMark: 1 });
    }

    /**
     * Reads the history through a Postgres cursor, `EXPORT_BATCH_SIZE` rows at a time, inside one read-only
     * transaction (so the file is a consistent snapshot) on its own connection. The `finally` runs also when the
     * client leaves halfway: Node closes the stream, the generator is returned and the connection goes back to the pool.
     */
    private async *generateCsv(whereSql: string, orderSql: string, args: unknown[]): AsyncGenerator<string> {
        // The header leaves together with the first batch: if the database fails before that, nothing was sent yet
        // and the client gets an error instead of a file that looks complete.
        let header = CSV_BOM + csvLine(CSV_HEADER);

        const runner = this.dataSource.createQueryRunner();
        await runner.connect();
        try {
            await runner.startTransaction();
            await runner.query(
                `DECLARE dispatch_history_export NO SCROLL CURSOR FOR ${ROW_SELECT_SQL} ${HISTORY_FROM_SQL} ${whereSql} ${orderSql}`,
                args,
            );
            let rows: HistoryRow[];
            do {
                rows = await runner.query(`FETCH ${EXPORT_BATCH_SIZE} FROM dispatch_history_export`);
                if (rows.length === 0) break;
                const departures = await this.findDepartures(rows.map((row) => row.id), runner.manager);
                yield header + rows.map((row) => this.toCsvLine(this.toDto(row, departures.get(row.id) ?? null))).join('');
                header = '';
            } while (rows.length === EXPORT_BATCH_SIZE);
            if (header) yield header; // no dispatch matched: the file still has its header row
        } finally {
            if (runner.isTransactionActive) await runner.rollbackTransaction();
            await runner.release();
        }
    }

    private toCsvLine(item: DispatchHistoryItemDto): string {
        return csvLine([
            item.trackingCode,
            item.recipient,
            item.driverName,
            item.plate,
            formatLocalIso(item.departedAt),
            formatLocalIso(item.deliveredAt),
            item.status,
        ]);
    }

    /**
     * When each dispatch left with its route: the last `out_for_delivery` event ("Iniciar ruta" writes
     * `departedAt` in its metadata). Looked up only for the rows of the page, by the index on `dispatch_id`.
     */
    private async findDepartures(dispatchIds: number[], manager: Pick<DataSource, 'query'> = this.dataSource): Promise<Map<number, Date>> {
        const departures = new Map<number, Date>();
        if (dispatchIds.length === 0) return departures;
        const rows: DepartureRow[] = await manager.query(
            `SELECT DISTINCT ON (e.dispatch_id) e.dispatch_id, e.metadata->>'departedAt' AS departed_at, e.created_at AS event_at
               FROM dispatch_events e
              WHERE e.dispatch_id = ANY($1::int[])
                AND e.event_type = 'status_changed'
                AND e.metadata->>'status' = $2
              ORDER BY e.dispatch_id, e.created_at DESC, e.dispatch_event_id DESC`,
            [dispatchIds, DispatchStatusEnum.OUT_FOR_DELIVERY],
        );
        for (const row of rows) {
            const recorded = row.departed_at ? new Date(row.departed_at) : null;
            departures.set(row.dispatch_id, recorded && !Number.isNaN(recorded.getTime()) ? recorded : row.event_at);
        }
        return departures;
    }

    private toDto(row: HistoryRow, departedAt: Date | null): DispatchHistoryItemDto {
        return {
            id: row.id,
            trackingCode: row.tracking_code,
            recipient: row.recipient,
            driverId: row.driver_id,
            driverName: row.driver_name,
            plate: row.plate,
            departedAt,
            // The delivery time is the closing time of a delivered dispatch; the other final statuses were not delivered.
            deliveredAt: row.status === DispatchStatusEnum.DELIVERED ? row.closed_at : null,
            status: row.status,
            closedAt: row.closed_at,
        };
    }
}
