import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { STATUS_NOTICE_RESERVED_EVENT, STATUS_NOTICE_RESULT_EVENT } from '../customer-status-notice-events.js';
import type { StatusNoticeDispatch } from '../domain/build-status-notice.js';

/** Serialises the reservations of one dispatch (first key of the advisory lock). */
const RESERVATION_LOCK_KEY = 39_001;

@Injectable()
export class CustomerStatusNoticeRepository {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    async findDispatch(dispatchId: number): Promise<StatusNoticeDispatch | null> {
        const rows: Array<{
            type: string; status: string; contact_email: string | null; tracking_code: string | null;
            tracking_token: string | null; tracking_token_expires_at: Date | null;
        }> = await this.dataSource.query(
            `SELECT t.name AS type, s.name AS status, d.contact_email, d.tracking_code, d.tracking_token, d.tracking_token_expires_at
               FROM dispatches d
               JOIN dispatch_types t ON t.dispatch_type_id = d.dispatch_type_id
               JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
              WHERE d.dispatch_id = $1`,
            [dispatchId],
        );
        const row = rows[0];
        if (!row) return null;
        return {
            dispatchId,
            type: row.type,
            currentStatus: row.status,
            contactEmail: row.contact_email,
            trackingCode: row.tracking_code,
            trackingToken: row.tracking_token,
            trackingTokenExpiresAt: row.tracking_token_expires_at,
        };
    }

    /**
     * Reserves the email of one transition (`dispatchId` + `status` + `occurredAt`) unless it is already reserved;
     * true when this call reserved it. A repeated event has the same `occurredAt`, a new passage through the
     * same status has another one. The advisory lock makes two concurrent copies of an event decide in turn.
     */
    async reserve(dispatchId: number, status: string, occurredAt: string): Promise<boolean> {
        return await this.dataSource.transaction(async (manager) => {
            await manager.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [RESERVATION_LOCK_KEY, dispatchId]);
            const rows: unknown[] = await manager.query(
                `INSERT INTO dispatch_events (dispatch_id, event_type, actor_type, reason, metadata)
                 SELECT $1::int, $2::varchar, 'system', $3::text, $4::jsonb
                  WHERE NOT EXISTS (
                        SELECT 1 FROM dispatch_events e
                         WHERE e.dispatch_id = $1::int AND e.event_type = $2::varchar
                           AND e.metadata->>'status' = $5::text AND e.metadata->>'occurredAt' = $6::text)
                 RETURNING dispatch_event_id`,
                [
                    dispatchId, STATUS_NOTICE_RESERVED_EVENT, `Status change email "${status}": handed to the mail transport`,
                    JSON.stringify({ status, occurredAt }), status, occurredAt,
                ],
            );
            return rows.length > 0;
        });
    }

    async recordResult(dispatchId: number, status: string, occurredAt: string, result: 'sent' | 'bounced' | 'failed'): Promise<void> {
        await this.dataSource.query(
            `INSERT INTO dispatch_events (dispatch_id, event_type, actor_type, reason, metadata)
             VALUES ($1, $2, 'system', $3, $4::jsonb)`,
            [dispatchId, STATUS_NOTICE_RESULT_EVENT, `Status change email "${status}": ${result}`, JSON.stringify({ status, occurredAt, result })],
        );
    }
}
