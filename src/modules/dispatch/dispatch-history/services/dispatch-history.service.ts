import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DispatchStatusEnum } from '../../../../shared/enums/dispatch-status.enum.js';
import { DispatchHistoryItemDto, FindDispatchHistoryResponseDto } from '../dto/dispatch-history.dto.js';
import { FindDispatchHistoryParamsDto } from '../dto/find-dispatch-history-params.dto.js';
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
            `SELECT d.dispatch_id AS id, d.tracking_code, d.contact_name AS recipient,
                    rb.driver_id, u.full_name AS driver_name, v.plate, s.name AS status, d.closed_at
             ${HISTORY_FROM_SQL} ${whereSql} ${orderSql}
             LIMIT ${bind(limit)} OFFSET ${bind((page - 1) * limit)}`,
            args,
        );

        const departures = await this.findDepartures(rows.map((row) => row.id));
        return { data: rows.map((row) => this.toDto(row, departures.get(row.id) ?? null)), total, page, limit };
    }

    /**
     * When each dispatch left with its route: the last `out_for_delivery` event ("Iniciar ruta" writes
     * `departedAt` in its metadata). Looked up only for the rows of the page, by the index on `dispatch_id`.
     */
    private async findDepartures(dispatchIds: number[]): Promise<Map<number, Date>> {
        const departures = new Map<number, Date>();
        if (dispatchIds.length === 0) return departures;
        const rows: DepartureRow[] = await this.dataSource.query(
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
