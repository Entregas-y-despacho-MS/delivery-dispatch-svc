import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SettingsService } from '../../../modules/settings/services/settings.service.js';
import { PROMISE_RESPONSE_WINDOW_KEY } from '../../promise-firming/services/promise-firming.service.js';
import { evaluateSelfService, type SelfServiceState } from '../domain/self-service.js';
import { isWellFormedTrackingToken } from '../domain/tracking-token.js';
import { PublicTrackingDto } from '../dto/public-tracking.dto.js';
import { RescheduleNotAvailableException, TrackingLinkNotFoundException } from '../exceptions/index.js';

export const MAX_RESCHEDULE_ATTEMPTS_KEY = 'max_reschedule_attempts';
export const WAREHOUSE_PREP_LEAD_KEY = 'warehouse_prep_lead_minutes';
export const RESCHEDULE_CODE_EXPIRY_KEY = 'reschedule_code_expiry_minutes';
const DEFAULT_WINDOW_MINUTES = 720;
const DEFAULT_MAX_RESCHEDULE_ATTEMPTS = 2;

interface TrackingRow {
    dispatch_id: number;
    status: string;
    version: number;
    tracking_code: string | null;
    customer_confirmation: string;
    promise_notified_at: Date | null;
    scheduled_window_start: Date | null;
    scheduled_window_end: Date | null;
    delivery_date: string | null;
    contact_email: string | null;
    has_contact_email: boolean;
    reschedule_attempts: number;
}

/** What the next stages of the public flow need after the token has been resolved. */
export interface TrackingContext {
    dispatchId: number;
    status: string;
    version: number;
    row: TrackingRow;
    selfService: SelfServiceState;
}

/**
 * Resolves a tracking link and says what the customer may do with it (ST-224.1, RF-U14, D-17).
 *
 * The token is the only way in: the `tracking_code` is not looked up at all, so it never opens the page.
 * Every link that does not work (malformed, unknown, expired) raises the same `TrackingLinkNotFoundException`,
 * and the token is never written to a log or to the audit trail from here.
 */
@Injectable()
export class PublicTrackingService {
    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly settings: SettingsService,
    ) {}

    async view(token: string, now: Date = new Date()): Promise<PublicTrackingDto> {
        const { row, selfService } = await this.resolve(token, now);
        return {
            trackingCode: row.tracking_code,
            status: row.status,
            customerConfirmation: row.customer_confirmation,
            deliveryDate: row.delivery_date,
            windowStart: row.scheduled_window_start,
            windowEnd: row.scheduled_window_end,
            selfService: {
                open: selfService.open,
                closedReason: selfService.closedReason,
                windowClosesAt: selfService.windowClosesAt,
                rescheduleAttemptsLeft: selfService.rescheduleAttemptsLeft,
                canConfirm: selfService.canConfirm,
                canReschedule: selfService.canReschedule,
                canRequestChange: selfService.canRequestChange,
            },
        };
    }

    async resolve(token: string, now: Date = new Date()): Promise<TrackingContext> {
        if (!isWellFormedTrackingToken(token)) throw new TrackingLinkNotFoundException();

        const [row]: TrackingRow[] = await this.dataSource.query(
            `SELECT d.dispatch_id, ds.name AS status, d.version, d.tracking_code, d.customer_confirmation, d.contact_email,
                    d.promise_notified_at, d.scheduled_window_start, d.scheduled_window_end,
                    to_char(rb.shift_date, 'YYYY-MM-DD') AS delivery_date,
                    (d.contact_email IS NOT NULL AND btrim(d.contact_email) <> '') AS has_contact_email,
                    (SELECT COUNT(*)::int FROM dispatch_reschedules r
                      WHERE r.dispatch_id = d.dispatch_id AND r.rescheduled_by_type = 'customer') AS reschedule_attempts
               FROM dispatches d
               JOIN dispatch_statuses ds ON ds.dispatch_status_id = d.dispatch_status_id
               LEFT JOIN route_batches rb ON rb.route_batch_id = d.route_batch_id
              WHERE d.tracking_token = $1
                AND (d.tracking_token_expires_at IS NULL OR d.tracking_token_expires_at > $2)`,
            [token, now],
        );
        if (!row) throw new TrackingLinkNotFoundException();

        const selfService = evaluateSelfService({
            status: row.status,
            customerConfirmation: row.customer_confirmation,
            promiseNotifiedAt: row.promise_notified_at,
            hasContactEmail: row.has_contact_email,
            rescheduleAttemptsUsed: row.reschedule_attempts,
            maxRescheduleAttempts: await this.settings.getNumber(MAX_RESCHEDULE_ATTEMPTS_KEY, DEFAULT_MAX_RESCHEDULE_ATTEMPTS),
            windowMinutes: await this.settings.getNumber(PROMISE_RESPONSE_WINDOW_KEY, DEFAULT_WINDOW_MINUTES),
            rescheduleConfigured: await this.rescheduleConfigured(),
            now,
        });
        return { dispatchId: row.dispatch_id, status: row.status, version: row.version, row, selfService };
    }

    /**
     * The rescheduling needs the warehouse lead time and the validity of the verification code (D-47). Both
     * ship blank: until Operations sets them nothing is offered or signed, because a promise the warehouse
     * cannot prepare must not be firmed.
     */
    async rescheduleConfigured(): Promise<boolean> {
        for (const key of [WAREHOUSE_PREP_LEAD_KEY, RESCHEDULE_CODE_EXPIRY_KEY]) {
            const value = Number((await this.settings.getString(key, '')).trim());
            if (!Number.isFinite(value) || value <= 0) return false;
        }
        return true;
    }
}

/** The rescheduling starts only while the self-service lets the customer reschedule; otherwise 409 with the reason. */
export function assertCanReschedule(context: TrackingContext): void {
    if (context.selfService.canReschedule && context.row.contact_email) return;
    throw new RescheduleNotAvailableException(rescheduleUnavailableReason(context));
}

function rescheduleUnavailableReason({ selfService, row }: TrackingContext): string {
    if (selfService.closedReason) return selfService.closedReason;
    return row.has_contact_email ? 'not_configured' : 'no_contact_email';
}
