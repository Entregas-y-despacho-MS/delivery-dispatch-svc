import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DispatchStatusEnum } from '../../../shared/enums/index.js';
import { escapeLike } from '../../../shared/utils/like.util.js';
import { canRevealTrackingLink } from '../domain/tracking-link-access.js';
import type { ChangeRequestItemDto, FindChangeRequestsResponseDto } from '../dto/change-request-item.dto.js';
import type { FindChangeRequestsParamsDto } from '../dto/find-change-requests-params.dto.js';

/** States in which a coordinator can still decide a change (the same ones the customer can ask from). */
const PENDING_STATUSES: string[] = [DispatchStatusEnum.SCHEDULED, DispatchStatusEnum.ASSIGNED];

interface ChangeRequestRow {
    dispatch_id: number;
    tracking_code: string | null;
    status: string;
    route_batch_id: number | null;
    delivery_date: string | null;
    scheduled_window_start: Date | null;
    scheduled_window_end: Date | null;
    zone_id: number | null;
    zone_name: string | null;
    contact_name: string | null;
    has_contact_email: boolean;
    has_live_token: boolean;
    promise_firmed_at: Date | null;
    request_detail: string | null;
    requested_at: Date;
    window_was_open: boolean | null;
    closed_reason: string | null;
}

/**
 * The coordinator's tray of change requests left by customers from the tracking link (ST-224.1 extension, ES-227).
 *
 * Read only. A request is a dispatch whose `customer_confirmation` is `change_requested` and that is still
 * `scheduled` or `assigned`; resolving it is `POST /dispatches/:id/reschedule` (ST-52.2), which moves it to
 * `rescheduled`, and that is what takes it out of this list. What the customer wrote is the `detail` of their last
 * `change_requested` event. The tracking token is never read into the list: `canRevealTrackingLink` only says
 * whether the viewer may ask for it with its own endpoint, which audits the request.
 */
@Injectable()
export class CustomerChangeRequestsService {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    async findAll(params: FindChangeRequestsParamsDto, viewerRole: string): Promise<FindChangeRequestsResponseDto> {
        const values: unknown[] = [PENDING_STATUSES];
        let where = `d.customer_confirmation = 'change_requested' AND s.name = ANY($1::text[])`;
        if (params.delivery_zone_id !== undefined) where += ` AND d.delivery_zone_id = $${values.push(params.delivery_zone_id)}`;
        if (params.date !== undefined) where += ` AND rb.shift_date = $${values.push(params.date)}::date`;
        if (params.search) {
            const pattern = `%${escapeLike(params.search)}%`;
            where += ` AND (d.tracking_code ILIKE $${values.push(pattern)} OR d.contact_name ILIKE $${values.length})`;
        }

        const from = `FROM dispatches d
                      JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
                 LEFT JOIN route_batches rb ON rb.route_batch_id = d.route_batch_id
                 LEFT JOIN delivery_zones z ON z.delivery_zone_id = d.delivery_zone_id
                 LEFT JOIN LATERAL (
                           SELECT e.detail, e.created_at, e.metadata
                             FROM dispatch_events e
                            WHERE e.dispatch_id = d.dispatch_id AND e.event_type = 'change_requested'
                            ORDER BY e.created_at DESC, e.dispatch_event_id DESC
                            LIMIT 1) r ON TRUE
                     WHERE ${where}`;

        const [{ total }]: { total: number }[] = await this.dataSource.query(`SELECT COUNT(*)::int AS total ${from}`, values);
        const page = params.page;
        const limit = params.limit;
        const rows: ChangeRequestRow[] = total === 0 ? [] : await this.dataSource.query(
            `SELECT d.dispatch_id, d.tracking_code, s.name AS status, d.route_batch_id,
                    to_char(rb.shift_date, 'YYYY-MM-DD') AS delivery_date,
                    d.scheduled_window_start, d.scheduled_window_end,
                    d.delivery_zone_id AS zone_id, z.name AS zone_name, d.contact_name,
                    (d.contact_email IS NOT NULL AND btrim(d.contact_email) <> '') AS has_contact_email,
                    (d.tracking_token IS NOT NULL AND (d.tracking_token_expires_at IS NULL OR d.tracking_token_expires_at > NOW())) AS has_live_token,
                    d.promise_firmed_at,
                    r.detail AS request_detail,
                    COALESCE(r.created_at, d.updated_at) AS requested_at,
                    CASE WHEN r.metadata ? 'selfServiceOpen' THEN (r.metadata->>'selfServiceOpen')::boolean END AS window_was_open,
                    r.metadata->>'selfServiceClosedReason' AS closed_reason
               ${from}
              ORDER BY COALESCE(r.created_at, d.updated_at), d.dispatch_id
              LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
            [...values, limit, (page - 1) * limit],
        );

        return {
            data: rows.map((row) => this.toItem(row, viewerRole)),
            meta: { page, limit, total, pages: Math.ceil(total / limit) },
        };
    }

    private toItem(row: ChangeRequestRow, viewerRole: string): ChangeRequestItemDto {
        return {
            dispatchId: row.dispatch_id,
            trackingCode: row.tracking_code,
            status: row.status,
            routeBatchId: row.route_batch_id,
            deliveryDate: row.delivery_date,
            windowStart: row.scheduled_window_start,
            windowEnd: row.scheduled_window_end,
            zoneId: row.zone_id,
            zoneName: row.zone_name,
            contactName: row.contact_name,
            hasContactEmail: row.has_contact_email,
            request: {
                detail: row.request_detail,
                requestedAt: row.requested_at,
                responseWindowWasOpen: row.window_was_open,
                selfServiceClosedReason: row.closed_reason,
            },
            promiseIsFirm: row.promise_firmed_at !== null,
            promiseFirmedAt: row.promise_firmed_at,
            canRevealTrackingLink: canRevealTrackingLink(viewerRole, {
                hasContactEmail: row.has_contact_email,
                hasLiveToken: row.has_live_token,
            }),
        };
    }
}
