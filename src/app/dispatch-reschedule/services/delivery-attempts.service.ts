import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { SettingsService } from '../../../modules/settings/services/settings.service.js';

export const MAX_DELIVERY_ATTEMPTS_KEY = 'max_delivery_attempts';
export const DEFAULT_MAX_DELIVERY_ATTEMPTS = 3;

export interface DeliveryAttempts {
    /** Times the dispatch entered `not_delivered`; each one counts. */
    notDelivered: number;
    /** Incidents reported with a reason that has `counts_as_attempt = TRUE`. */
    incidents: number;
    used: number;
    limit: number;
    limitReached: boolean;
}

interface AttemptRow {
    not_delivered: number;
    incidents: number;
}

/**
 * Delivery attempts already spent by a dispatch (D-30, ES-52). PROVISIONAL rule until A-9 is settled:
 *
 * - every entry into `not_delivered` counts (a `status_changed` event whose `metadata.status` is `not_delivered`
 *   and whose previous status was another one, so a repeated report of the same state is not a new attempt);
 * - every incident counts only when its reason has `counts_as_attempt = TRUE` (the same definition the Kanban uses);
 * - the rows of `dispatch_reschedules` are NOT counted: a reschedule is not an attempt (D-28, D-30).
 *
 * The whole rule lives here so that resolving A-9 changes one place. Known overlap: a failure reported as
 * `not_delivered` and then as an incident would count twice; D-30 accepts it while the rule is provisional.
 */
@Injectable()
export class DeliveryAttemptsService {
    constructor(private readonly settings: SettingsService) {}

    async count(manager: EntityManager, dispatchId: number): Promise<DeliveryAttempts> {
        const [row]: AttemptRow[] = await manager.query(
            `SELECT
                (SELECT COUNT(*)::int FROM dispatch_events e
                  WHERE e.dispatch_id = $1 AND e.event_type = 'status_changed'
                    AND e.metadata->>'status' = 'not_delivered'
                    AND COALESCE(e.metadata->>'previousStatus', '') <> 'not_delivered') AS not_delivered,
                (SELECT COUNT(*)::int FROM dispatch_incidents i
                   JOIN incident_reasons ir ON ir.incident_reason_id = i.incident_reason_id
                  WHERE i.dispatch_id = $1 AND ir.counts_as_attempt = TRUE) AS incidents`,
            [dispatchId],
        );
        const limit = await this.settings.getNumber(MAX_DELIVERY_ATTEMPTS_KEY, DEFAULT_MAX_DELIVERY_ATTEMPTS);
        const notDelivered = Number(row?.not_delivered ?? 0);
        const incidents = Number(row?.incidents ?? 0);
        const used = notDelivered + incidents;
        return { notDelivered, incidents, used, limit, limitReached: used >= limit };
    }
}
