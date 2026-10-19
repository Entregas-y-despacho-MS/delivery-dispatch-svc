import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SettingsService } from '../../modules/settings/services/settings.service.js';
import { DispatchNotFoundException } from '../../modules/dispatch/dispatches/exceptions/dispatch-not-found.exception.js';
import { SmsSender } from '../../plugins/sms/sms.port.js';
import { CacheUnavailableException } from '../../plugins/cache/exceptions/index.js';
import { DispatchOtpStore } from './ports/dispatch-otp-store.port.js';
import { createOtp, matchesOtp, otpOptions, OTP_CODE_LENGTH_KEY, OTP_EXPIRY_MINUTES_KEY } from './domain/otp-code.js';
import { DispatchOtpException } from './exceptions/dispatch-otp.exception.js';

interface DispatchContact {
    id: number;
    contact_phone: string | null;
    evidence_policy: string;
    status: string;
    driver_id: number | null;
}

@Injectable()
export class DispatchOtpService {
    private readonly logger = new Logger(DispatchOtpService.name);

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly store: DispatchOtpStore,
        private readonly sms: SmsSender,
        private readonly settings: SettingsService,
    ) {}

    async markProcessingFailure(dispatchId: number): Promise<void> {
        await this.record(dispatchId, 'otp_resolution_required', { reason: 'otp_processing_failed', recovery: 'controlled_resend' });
    }

    async onInTransit(dispatchId: number): Promise<void> {
        const row = await this.contact(dispatchId);
        if (!row || row.status !== 'in_transit' || row.evidence_policy !== 'high_value_control') return;
        await this.send(row, false);
    }

    async resend(dispatchId: number, driverId: number): Promise<{ sent: boolean; expiresAt: string }> {
        const row = await this.contact(dispatchId);
        if (!row) throw new DispatchNotFoundException();
        if (row.driver_id !== driverId) throw new DispatchOtpException('INSUFFICIENT_PERMISSIONS', 'Dispatch is not assigned to your route.', 403);
        if (row.status !== 'in_transit' || row.evidence_policy !== 'high_value_control') {
            throw new DispatchOtpException('OTP_NOT_APPLICABLE', 'OTP requires an in-transit high-value dispatch.');
        }
        const result = await this.send(row, true);
        if (!result) throw new DispatchOtpException('OTP_CONTACT_REQUIRED', 'Dispatch must resolve the verified customer phone.');
        return result;
    }

    /** Integration seam for ST-31.3; no delivery-evidence or public verification endpoint is added here. */
    async verify(dispatchId: number, code: string): Promise<string> {
        try {
            const hash = await this.store.readHash(dispatchId);
            return await this.store.verify(dispatchId, hash ?? '', hash !== null && await matchesOtp(code, hash));
        } catch (error) {
            if (error instanceof CacheUnavailableException) throw new DispatchOtpException('OTP_UNAVAILABLE', 'OTP is temporarily unavailable.', 503);
            throw error;
        }
    }

    private async contact(dispatchId: number): Promise<DispatchContact | undefined> {
        const [row]: DispatchContact[] = await this.dataSource.query(
            `SELECT d.dispatch_id AS id, d.contact_phone, d.evidence_policy, ds.name AS status, b.driver_id
             FROM dispatches d JOIN dispatch_statuses ds ON ds.dispatch_status_id = d.dispatch_status_id
             LEFT JOIN route_batches b ON b.route_batch_id = d.route_batch_id
             WHERE d.dispatch_id = $1`, [dispatchId],
        );
        return row;
    }

    private async send(row: DispatchContact, resend: boolean): Promise<{ sent: boolean; expiresAt: string } | null> {
        // Source systems attest verification (user decision, 2026-10-18). A missing or unusable phone is never downgraded.
        const phone = row.contact_phone?.replace(/[ -]/g, '');
        if (!phone || !/^\+?[1-9][0-9]{6,14}$/.test(phone)) {
            await this.record(row.id, 'otp_resolution_required', { reason: 'verified_phone_missing' });
            return null;
        }
        const options = otpOptions(await this.settings.getNumber(OTP_CODE_LENGTH_KEY, 6), await this.settings.getNumber(OTP_EXPIRY_MINUTES_KEY, 60));
        const { code, hash } = await createOtp(options.length);
        try {
            let issued = await this.store.issue(row.id, hash, options.ttlSeconds, resend);
            // Recover an initial asynchronous attempt that never reached Redis (outage/crash).
            // The same atomic NX path keeps concurrent retry and listener delivery idempotent.
            if (resend && issued === 'not_issued') issued = await this.store.issue(row.id, hash, options.ttlSeconds, false);
            if (issued === 'already_issued') {
                if (resend) throw new DispatchOtpException('OTP_ALREADY_ISSUED', 'Another request issued the OTP; use its message or retry a controlled resend.');
                return null;
            }
            if (issued !== 'issued') throw new DispatchOtpException(`OTP_${issued.toUpperCase()}`, 'OTP cannot be issued in its current state.');
            try {
                await this.sms.send({ to: phone, body: `Tu código de entrega es ${code}. Dáselo al repartidor solo al recibir tu pedido. Válido por ${options.ttlSeconds / 60} minutos.` });
            } catch {
                await this.store.invalidate(row.id, hash);
                await this.record(row.id, 'otp_send_failed', { resend });
                throw new DispatchOtpException('OTP_SEND_FAILED', 'OTP could not be sent; request a controlled resend.', 503);
            }
            const expiresAt = new Date(Date.now() + options.ttlSeconds * 1000).toISOString();
            await this.record(row.id, resend ? 'otp_resent' : 'otp_sent', { expiresAt });
            return { sent: true, expiresAt };
        } catch (error) {
            if (error instanceof CacheUnavailableException) throw new DispatchOtpException('OTP_UNAVAILABLE', 'OTP is temporarily unavailable.', 503);
            throw error;
        }
    }

    private async record(dispatchId: number, eventType: string, metadata: Record<string, unknown>): Promise<void> {
        const inserted = await this.dataSource.transaction(async (manager) => {
            // All OTP lifecycle writers use the same dispatch lock. Never acquire a route lock here:
            // status transitions lock route -> dispatch, so doing the reverse would risk deadlock.
            await manager.query('SELECT dispatch_id FROM dispatches WHERE dispatch_id = $1 FOR UPDATE', [dispatchId]);
            if (eventType === 'otp_resolution_required') {
                // One marker per unresolved episode, regardless of its first reason. Successful sends
                // close an episode implicitly. Server sequence IDs remain ordered for backdated events.
                return await manager.query(
                    `INSERT INTO dispatch_events (dispatch_id, event_type, actor_type, reason, metadata)
                     SELECT $1, $2, 'system', 'Delivery OTP lifecycle', $3::jsonb
                     WHERE NOT EXISTS (
                         SELECT 1 FROM dispatch_events pending
                         WHERE pending.dispatch_id = $1 AND pending.event_type = 'otp_resolution_required'
                           AND pending.dispatch_event_id > COALESCE((
                               SELECT MAX(sent.dispatch_event_id) FROM dispatch_events sent
                               WHERE sent.dispatch_id = $1 AND sent.event_type IN ('otp_sent', 'otp_resent')
                           ), 0)
                     ) RETURNING dispatch_event_id`,
                    [dispatchId, eventType, JSON.stringify(metadata)],
                );
            }
            return await manager.query(
                `INSERT INTO dispatch_events (dispatch_id, event_type, actor_type, reason, metadata)
                 VALUES ($1, $2, 'system', 'Delivery OTP lifecycle', $3::jsonb) RETURNING dispatch_event_id`,
                [dispatchId, eventType, JSON.stringify(metadata)],
            );
        });
        if (inserted.length > 0) this.logger.log({ event: eventType, dispatchId });
    }
}
