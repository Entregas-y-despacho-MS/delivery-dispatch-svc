import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DispatchNotFoundException } from '../../../modules/dispatch/dispatches/exceptions/index.js';
import { DispatchStatusEnum } from '../../../shared/enums/index.js';
import { trackingLinkBlock } from '../domain/tracking-link-access.js';
import type { TrackingLinkDto } from '../dto/tracking-link.dto.js';
import { ChangeRequestNotPendingException, TrackingLinkNotAvailableException } from '../exceptions/index.js';

export const TRACKING_LINK_REVEALED_EVENT = 'tracking_link_revealed';

const PENDING_STATUSES: string[] = [DispatchStatusEnum.SCHEDULED, DispatchStatusEnum.ASSIGNED];

interface LinkRow {
    status: string;
    customer_confirmation: string;
    has_contact_email: boolean;
    tracking_token: string | null;
    has_live_token: boolean;
}

/**
 * Shows a coordinator the tracking link of a customer who asked for a change and has no email (ST-224.1 extension, ES-227).
 *
 * The link is the customer's only credential, so it is never part of a list: it is asked for one delivery at a time,
 * only for a pending change request, only when the order has no email (the customer already got it there otherwise)
 * and only while the token works. Each time it is shown, in the same transaction that reads it, the event
 * `tracking_link_revealed` records who asked and when; the event never contains the token or the link. The caller
 * must be a coordinator (the controller guarantees it).
 */
@Injectable()
export class TrackingLinkRevealService {
    private readonly webUrl: string;

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        config: ConfigService,
    ) {
        this.webUrl = config.get<string>('PUBLIC_WEB_URL', 'http://localhost:5173')!.replace(/\/$/, '');
    }

    async reveal(dispatchId: number, actorUserId: number): Promise<TrackingLinkDto> {
        return await this.dataSource.transaction(async (manager) => {
            const [row]: LinkRow[] = await manager.query(
                `SELECT s.name AS status, d.customer_confirmation, d.tracking_token,
                        (d.contact_email IS NOT NULL AND btrim(d.contact_email) <> '') AS has_contact_email,
                        (d.tracking_token IS NOT NULL AND (d.tracking_token_expires_at IS NULL OR d.tracking_token_expires_at > NOW())) AS has_live_token
                   FROM dispatches d JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
                  WHERE d.dispatch_id = $1
                    FOR UPDATE OF d`,
                [dispatchId],
            );
            if (!row) throw new DispatchNotFoundException();
            if (row.customer_confirmation !== 'change_requested' || !PENDING_STATUSES.includes(row.status)) throw new ChangeRequestNotPendingException();

            const block = trackingLinkBlock({ hasContactEmail: row.has_contact_email, hasLiveToken: row.has_live_token });
            if (block !== null) throw new TrackingLinkNotAvailableException(block);

            await manager.query(
                `INSERT INTO dispatch_events (dispatch_id, event_type, actor_user_id, actor_type, reason, metadata)
                 VALUES ($1, $2, $3, 'user', 'Coordinator asked for the tracking link of a customer without email', '{}'::jsonb)`,
                [dispatchId, TRACKING_LINK_REVEALED_EVENT, actorUserId],
            );
            return { dispatchId, trackingUrl: `${this.webUrl}/seguimiento/${row.tracking_token}` };
        });
    }
}
