import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { FindDriverHistoryParamsDto } from '../dto/find-driver-history-params.dto.js';
import { DriverHistoryItemDto, DriverHistoryResponseDto } from '../dto/driver-history-response.dto.js';

interface DriverHistoryRow {
    tracking_code: string | null;
    customer_name: string | null;
    receiver_name: string | null;
    status: 'delivered' | 'returned';
    closed_at: Date;
    evidence_id: string | null;
}

@Injectable()
export class DriverHistoryService {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    async findHistory(driverId: number, params: FindDriverHistoryParamsDto): Promise<DriverHistoryResponseDto> {
        const page = params.page ?? 1;
        const limit = params.limit ?? 20;
        const values: unknown[] = [driverId];
        const where = [
            `rb.driver_id = $1`,
            `s.name IN ('delivered', 'returned')`,
            `d.closed_at IS NOT NULL`,
        ];
        const addValue = (value: unknown): number => { values.push(value); return values.length; };

        if (params.status !== undefined) where.push(`s.name = $${addValue(params.status)}`);
        if (params.from !== undefined) {
            const index = addValue(params.from);
            where.push(`d.closed_at >= ($${index}::date::timestamp AT TIME ZONE 'America/La_Paz')`);
        }
        if (params.to !== undefined) {
            const index = addValue(params.to);
            where.push(`d.closed_at < (($${index}::date + 1)::timestamp AT TIME ZONE 'America/La_Paz')`);
        }
        if (params.search !== undefined && params.search.length > 0) {
            const escapedSearch = params.search.replace(/[\\%_]/g, '\\$&');
            const index = addValue(`%${escapedSearch}%`);
            where.push(`d.tracking_code ILIKE $${index} ESCAPE E'\\\\'`);
        }

        const predicate = where.join(' AND ');
        const countValues = [...values];
        const offset = (page - 1) * limit;
        const limitIndex = addValue(limit);
        const offsetIndex = addValue(offset);
        const [countRows, rows] = await Promise.all([
            this.dataSource.query(
                `SELECT COUNT(*)::int AS total
                   FROM dispatches d
                   JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
                   JOIN route_batches rb ON rb.route_batch_id = d.route_batch_id
                  WHERE ${predicate}`,
                countValues,
            ) as Promise<{ total: number }[]>,
            this.dataSource.query(
                `SELECT d.tracking_code, d.contact_name AS customer_name, s.name AS status,
                        d.closed_at, evidence.evidence_id AS evidence_id,
                        evidence.receiver_name AS receiver_name
                   FROM dispatches d
                   JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
                   JOIN route_batches rb ON rb.route_batch_id = d.route_batch_id
                   LEFT JOIN LATERAL (
                       SELECT e.delivery_evidence_id AS evidence_id, e.receiver_name
                         FROM delivery_evidences e
                        WHERE e.dispatch_id = d.dispatch_id
                        ORDER BY e.captured_at DESC NULLS LAST, e.created_at DESC, e.delivery_evidence_id DESC
                        LIMIT 1
                   ) evidence ON TRUE
                  WHERE ${predicate}
                  ORDER BY d.closed_at DESC, d.dispatch_id DESC
                  LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
                values,
            ) as Promise<DriverHistoryRow[]>,
        ]);

        const data: DriverHistoryItemDto[] = rows.map((row) => ({
            trackingCode: row.tracking_code,
            customerName: row.customer_name,
            receiverName: row.receiver_name,
            status: row.status,
            closedAt: row.closed_at,
            evidenceId: row.evidence_id,
        }));
        return { data, total: Number(countRows[0]?.total ?? 0), page, limit };
    }
}
