import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { DtoRepository } from '../../../shared/orm/index.js';
import { PaginationResponseDto } from '../../../shared/dto/index.js';
import { OPERATING_TIME_ZONE, todayInOperatingTimeZone } from '../../dispatch/dispatches/utils/operating-date.util.js';
import { OperationalAlertKindEnum, OperationalAlertSeverityEnum, OperationalAlertStatusEnum } from '../../../shared/enums/operational-alert.enum.js';
import { OperationalAlert } from '../entities/operational-alert.entity.js';
import { OperationalAlertDto } from '../dto/operational-alert.dto.js';
import { FindAllOperationalAlertsParamsDto } from '../dto/find-all-operational-alerts-params.dto.js';
import { OperationalAlertNotFoundException, OperationalAlertAlreadyAcknowledgedException } from '../exceptions/index.js';
import { OPERATIONAL_ALERT_RAISED_EVENT } from '../events/operational-alert-raised.event.js';

export interface RaiseAlertParams {
    kind: OperationalAlertKindEnum;
    severity: OperationalAlertSeverityEnum;
    zoneId?: number | null;
    dispatchId?: number | null;
    driverId?: number | null;
    vehicleId?: number | null;
    detail: Record<string, unknown>;
}

interface RaisedRow {
    operational_alert_id: number;
}

/**
 * RF-A19 (ES-66). `raise()` is the only writer of new alerts — it relies entirely on
 * `uq_operational_alerts_open_subject` (kind + COALESCE(zone/dispatch/driver, -1), WHERE status='open')
 * to decide whether a given subject already has this kind of alert open: a plain `INSERT ...
 * ON CONFLICT DO NOTHING` either creates the row or does nothing, with no read-then-write race.
 * `vehicleId` is informational only — deliberately excluded from that index (ST-66.1 decision):
 * it must never let two alerts for the same real subject coexist just because one message carried
 * a different (or missing) vehicle than the other.
 */
@Injectable()
export class OperationalAlertsService {
    private readonly logger = new Logger(OperationalAlertsService.name);
    private readonly repo: DtoRepository<OperationalAlert>;

    constructor(
        @InjectRepository(OperationalAlert) private readonly rawRepo: Repository<OperationalAlert>,
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly events: EventEmitter2,
    ) {
        this.repo = new DtoRepository(rawRepo);
    }

    async findAll<T>(dto: new () => T, params: FindAllOperationalAlertsParamsDto): Promise<PaginationResponseDto<T>> {
        return this.repo.findPaginated({
            dto,
            pagination: params,
            where: { ...(params.status !== undefined && { status: params.status }) },
            order: { createdAt: 'DESC', id: 'DESC' },
        });
    }

    /**
     * Inserts the alert if its subject has no open alert of this kind yet, and was not already
     * acknowledged today. Emits `OPERATIONAL_ALERT_RAISED_EVENT` only when it actually inserted — a
     * duplicate while one stays open must never re-notify (Escenario 2 de ES-66). Without the
     * acknowledged-today check, a `gps_stale`/`driver_incidents`/`sla_below_threshold` alert that a
     * supervisor just acknowledged would come right back on the next minute's evaluation if the
     * underlying condition is still true — defeating what acknowledging it was for. `critical_incident`
     * never repeats for the same dispatch anyway (a dispatch only gets one `dispatch_incidents` row
     * before it leaves `in_transit`), so this check is a no-op for it in practice.
     */
    async raise(params: RaiseAlertParams): Promise<void> {
        const [acknowledgedToday]: unknown[] = await this.dataSource.query(
            `SELECT 1 FROM operational_alerts
              WHERE kind = $1 AND COALESCE(zone_id, -1) = COALESCE($2, -1)
                AND COALESCE(dispatch_id, -1) = COALESCE($3, -1) AND COALESCE(driver_id, -1) = COALESCE($4, -1)
                AND status = 'acknowledged'
                AND acknowledged_at >= ($5::date)::timestamp AT TIME ZONE '${OPERATING_TIME_ZONE}'
              LIMIT 1`,
            [params.kind, params.zoneId ?? null, params.dispatchId ?? null, params.driverId ?? null, todayInOperatingTimeZone()],
        );
        if (acknowledgedToday) return;

        const rows: RaisedRow[] = await this.dataSource.query(
            `INSERT INTO operational_alerts (kind, severity, zone_id, dispatch_id, driver_id, vehicle_id, detail, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')
             ON CONFLICT (kind, COALESCE(zone_id, -1), COALESCE(dispatch_id, -1), COALESCE(driver_id, -1))
                 WHERE status = 'open'
             DO NOTHING
             RETURNING operational_alert_id`,
            [
                params.kind, params.severity,
                params.zoneId ?? null, params.dispatchId ?? null, params.driverId ?? null, params.vehicleId ?? null,
                JSON.stringify(params.detail),
            ],
        );
        if (rows.length === 0) return; // Already open for this subject — no duplicate, no re-notify.

        const event = {
            id: rows[0].operational_alert_id,
            kind: params.kind,
            severity: params.severity,
            zoneId: params.zoneId ?? null,
            dispatchId: params.dispatchId ?? null,
            driverId: params.driverId ?? null,
            detail: params.detail,
        };
        try {
            this.events.emit(OPERATIONAL_ALERT_RAISED_EVENT, event);
        } catch (error) {
            this.logger.error(`Alert ${event.id} (${params.kind}) was raised but its broadcast could not be queued.`, error as Error);
        }
    }

    /** `userId` is whoever is acknowledging it (Escenario 3) — a supervisor or coordinator, enforced by the controller's roles. */
    async acknowledge(id: number, userId: number): Promise<OperationalAlertDto> {
        const result = await this.rawRepo.createQueryBuilder()
            .update(OperationalAlert)
            .set({ status: OperationalAlertStatusEnum.ACKNOWLEDGED, acknowledgedBy: userId, acknowledgedAt: new Date() })
            .where('operational_alert_id = :id', { id })
            .andWhere('status = :open', { open: OperationalAlertStatusEnum.OPEN })
            .execute();

        if ((result.affected ?? 0) > 0) {
            return (await this.repo.findOne({ dto: OperationalAlertDto, where: { id } }))!;
        }

        const existing = await this.rawRepo.existsBy({ id });
        if (!existing) throw new OperationalAlertNotFoundException();
        throw new OperationalAlertAlreadyAcknowledgedException();
    }
}
