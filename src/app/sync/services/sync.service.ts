/// <reference types="multer" />
import { BadRequestException, HttpException, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DISPATCH_STATUS_CHANGED_EVENT, type DispatchStatusChangedEvent } from '../../dispatch-status/dispatch-status-changed.event.js';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { DispatchEventsService } from '../../../modules/dispatch/dispatch-events/services/dispatch-events.service.js';
import { DispatchIncidentsService } from '../../../modules/dispatch/dispatch-incidents/services/dispatch-incidents.service.js';
import { DeliveryEvidencesService } from '../../../modules/dispatch/delivery-evidences/services/delivery-evidences.service.js';
import { DispatchesService } from '../../../modules/dispatch/dispatches/services/dispatches.service.js';
import { DispatchNotFoundException } from '../../../modules/dispatch/dispatches/exceptions/index.js';
import { isTerminalDispatchStatus } from '../../../modules/dispatch/dispatches/utils/terminal-statuses.js';
import { StoragePort } from '../../../plugins/storage/storage.port.js';
import { FINAL_STATUSES } from '../../../modules/dispatch/dispatches/services/dispatches.service.js';
import { SyncEventDto } from '../dto/sync-event.dto.js';
import { SyncEventType } from '../dto/sync-event-type.enum.js';
import { SyncEventOutcome, SyncEventResultDto, SyncEventsBatchResultDto } from '../dto/sync-event-result.dto.js';
import { SyncEvidenceDto } from '../dto/sync-evidence.dto.js';
import { DispatchStatusPublicationService } from '../../../modules/dispatch/dispatch-status-publication/dispatch-status-publication.service.js';
import { PUBLISHED_DELIVERY_OUTCOME_STATUSES } from '../../../modules/dispatch/dispatch-status-publication/dispatch-status-message.js';

import { SyncOtpVerificationRequiredException } from '../exceptions/sync-otp-verification-required.exception.js';
import { DispatchEvidenceRequiredException } from '../../dispatch-status/exceptions/dispatch-evidence-required.exception.js';

const DRIVER_SYNC_STATUSES = new Set(['in_transit', 'delivered', 'not_delivered']);

// A device clock is never exact, but an event from 2099 or from last year is not a real one: it would
// corrupt the history (and every report built on it).
const MAX_FUTURE_MS = 60 * 60 * 1000;
const MAX_AGE_MS    = 30 * 24 * 60 * 60 * 1000;
// Tolerate device/server clock drift without accepting events far outside the route's lifetime.
const ROUTE_EXECUTION_CLOCK_SKEW_MS = 5 * 60 * 1000;

// RF-U13 — orquesta la sincronización offline: idempotencia por clientEventId + orden estricto
// del lote. Las operaciones genéricas (create/exists) viven en cada módulo de dominio; acá solo
// la lógica de "qué hacer con eso" — ver .claude/rules/... del propio proyecto.
@Injectable()
export class SyncService {
    private readonly logger = new Logger(SyncService.name);

    constructor(
        @InjectDataSource()
        private readonly dataSource: DataSource,
        private readonly dispatchEventsService: DispatchEventsService,
        private readonly dispatchIncidentsService: DispatchIncidentsService,
        private readonly deliveryEvidencesService: DeliveryEvidencesService,
        private readonly dispatchesService: DispatchesService,
        private readonly storage: StoragePort,
        private readonly statusPublication: DispatchStatusPublicationService,
        private readonly events: EventEmitter2,
    ) {}

    /**
     * Procesa el lote en el orden exacto en que llega (FIFO) — un evento fallido no aborta los
     * siguientes, se reporta su propio resultado para que el móvil sepa cuál reintentar.
     */
    async processBatch(events: SyncEventDto[], driverId: number): Promise<SyncEventsBatchResultDto> {
        const results: SyncEventResultDto[] = [];
        for (const event of events) {
            results.push(await this.processOneSafely(event, driverId));
        }
        return { results };
    }

    async syncEvidence(dto: SyncEvidenceDto, file: Express.Multer.File | undefined, driverId: number): Promise<SyncEventResultDto> {
        try {
            if (dto.type === 'otp') throw new SyncOtpVerificationRequiredException();
            if (await this.deliveryEvidencesService.existsById(dto.clientEventId)) {
                return { clientEventId: dto.clientEventId, outcome: SyncEventOutcome.ALREADY_PROCESSED };
            }
            if (!(await this.dispatchesService.isAssignedToDriver(dto.dispatchId, driverId))) throw new DispatchNotFoundException();

            // Photo and signature evidence must include the actual file.
            if (dto.type !== 'otp' && !file) throw new BadRequestException('A photo or signature evidence needs its file.');

            let fileUrl: string | null = null;
            if (file) {
                const uploaded = await this.storage.upload({ buffer: file.buffer, filename: file.originalname, mimeType: file.mimetype });
                fileUrl = uploaded.url;
            }

            const evidence = await this.deliveryEvidencesService.create({
                id:         dto.clientEventId,
                dispatchId: dto.dispatchId,
                type:       dto.type,
                fileUrl,
                // OTP evidence is accepted only by the server validation flow.
                otpCode:    null,
            });
            this.events.emit('dispatch.evidence_registered', {
                dispatchId: dto.dispatchId,
                evidenceId: evidence.id,
                type: evidence.type,
                registeredAt: evidence.createdAt.toISOString(),
            });
            return { clientEventId: dto.clientEventId, outcome: SyncEventOutcome.APPLIED };
        } catch (err) {
            return this.toFailedResult(dto.clientEventId, err);
        }
    }

    private async processOneSafely(event: SyncEventDto, driverId: number): Promise<SyncEventResultDto> {
        try {
            const outcome = await this.processOne(event, driverId);
            return { clientEventId: event.clientEventId, outcome };
        } catch (err) {
            return this.toFailedResult(event.clientEventId, err);
        }
    }

    private async processOne(event: SyncEventDto, driverId: number): Promise<SyncEventOutcome> {
        let statusChangedEvent: DispatchStatusChangedEvent | undefined;
        let incidentReportedEvent: { dispatchId: number; incidentId: string; reasonCode: string; reportedAt: string } | undefined;
        const outcome = await this.dataSource.transaction(async (manager) => {
            const options = { manager };

            if (event.type === SyncEventType.STATUS_CHANGE) {
                if (await this.dispatchEventsService.existsByClientEventId(event.clientEventId, options)) {
                    return SyncEventOutcome.ALREADY_PROCESSED;
                }
                this.assertPlausibleTime(event.occurredAt);

                // Unknown dispatch and someone else's dispatch answer the same: a driver cannot probe other routes.
                const [lockedDispatch] = await manager.query(
                    'SELECT dispatch_id, evidence_policy FROM dispatches WHERE dispatch_id = $1 FOR UPDATE',
                    [event.dispatchId],
                );
                if (!lockedDispatch) throw new DispatchNotFoundException();
                if (!(await this.dispatchesService.isAssignedToDriver(event.dispatchId, driverId, options))) throw new DispatchNotFoundException();
                await this.assertWithinRouteExecution(manager, event.dispatchId, driverId, new Date(event.occurredAt));
                // A finished order (delivered / returned) cannot go back: a late or duplicated event from the
                // device must not reopen it.
                const current = await this.dispatchesService.getStatusName(event.dispatchId, options);
                const target  = await this.dispatchesService.getStatusNameById(event.dispatchStatusId!, options);
                if (!target) throw new BadRequestException('The given dispatch status does not exist.');
                if (current && FINAL_STATUSES.includes(current) && target !== current) {
                    throw new BadRequestException(`The dispatch is already ${current}: its status cannot change.`);
                }
                if (!current) throw new BadRequestException('The dispatch has no configured current status.');
                if (!DRIVER_SYNC_STATUSES.has(target)) {
                    throw new BadRequestException(`The driver cannot set dispatch status ${target}.`);
                }
                if (target === 'delivered' && lockedDispatch.evidence_policy === 'high_value_control' &&
                    !(await this.deliveryEvidencesService.existsByDispatchAndType(event.dispatchId, 'otp', options))) {
                    throw new DispatchEvidenceRequiredException('otp');
                }
                const occurredAt = new Date(event.occurredAt);
                const outboundRecordVersion = current !== target && PUBLISHED_DELIVERY_OUTCOME_STATUSES.includes(target)
                    ? await this.statusPublication.publish(manager, {
                        dispatchId: event.dispatchId,
                        status: target,
                        previousStatus: current,
                        occurredAt,
                    })
                    : null;
                // The history's closing time is when it happened on the device, not when the sync arrives (ST-55.2).
                await this.dispatchesService.updateStatus(
                    event.dispatchId,
                    event.dispatchStatusId!,
                    options,
                    current !== target && isTerminalDispatchStatus(target) ? occurredAt : undefined,
                );
                await this.dispatchEventsService.create({
                    dispatchId:    event.dispatchId,
                    eventType:     'status_changed',
                    detail:        event.detail ?? null,
                    clientEventId: event.clientEventId,
                    occurredAt,
                    metadata: {
                        previousStatus: current,
                        status: target,
                        occurredAt: event.occurredAt,
                        ...(outboundRecordVersion !== null && { outboundRecordVersion }),
                    },
                }, options);
                if (current !== target) {
                    const [updated]: { version: number; updated_at: Date | string }[] = await manager.query(
                        'SELECT version, updated_at FROM dispatches WHERE dispatch_id = $1', [event.dispatchId],
                    );
                    statusChangedEvent = { dispatchId: event.dispatchId, status: target, previousStatus: current,
                        version: updated.version, updatedAt: new Date(updated.updated_at).toISOString() };
                }
                return SyncEventOutcome.APPLIED;
            }

            // INCIDENT
            if (await this.dispatchIncidentsService.existsById(event.clientEventId, options)) {
                return SyncEventOutcome.ALREADY_PROCESSED;
            }
            this.assertPlausibleTime(event.occurredAt);
            const [lockedDispatch] = await manager.query(
                'SELECT dispatch_id FROM dispatches WHERE dispatch_id = $1 FOR UPDATE',
                [event.dispatchId],
            );
            if (!lockedDispatch) throw new DispatchNotFoundException();
            if (!(await this.dispatchesService.isAssignedToDriver(event.dispatchId, driverId, options))) throw new DispatchNotFoundException();
            await this.assertWithinRouteExecution(manager, event.dispatchId, driverId, new Date(event.occurredAt));

            const current = await this.dispatchesService.getStatusName(event.dispatchId, options);
            if (current && FINAL_STATUSES.includes(current) && current !== 'incident') {
                throw new BadRequestException(`The dispatch is already ${current}: its status cannot change.`);
            }
            const [reason]: { code: string }[] = await manager.query(
                'SELECT code FROM incident_reasons WHERE incident_reason_id = $1 AND deleted_at IS NULL',
                [event.incidentReasonId],
            );
            if (!reason) throw new BadRequestException('The given incident reason does not exist.');
            const incidentStatusId = await this.dispatchesService.getStatusIdByName('incident', options);
            if (!incidentStatusId) throw new BadRequestException('The incident dispatch status is not configured.');

            let outboundRecordVersion: number | null = null;
            if (!current) throw new BadRequestException('The dispatch has no configured current status.');
            if (current !== 'incident') {
                outboundRecordVersion = await this.statusPublication.publish(manager, {
                    dispatchId: event.dispatchId,
                    status: 'incident',
                    previousStatus: current,
                    occurredAt: new Date(event.occurredAt),
                    reasonCode: reason.code,
                });
                await this.dispatchesService.updateStatus(event.dispatchId, incidentStatusId, options);
            }

            await this.dispatchIncidentsService.create({
                id:               event.clientEventId,
                dispatchId:       event.dispatchId,
                incidentReasonId: event.incidentReasonId!,
                description:      event.detail ?? null,
                occurredAt:       new Date(event.occurredAt),
            }, options);
            incidentReportedEvent = {
                dispatchId: event.dispatchId,
                incidentId: event.clientEventId,
                reasonCode: reason.code,
                reportedAt: new Date().toISOString(),
            };
            await this.dispatchEventsService.create({
                dispatchId: event.dispatchId,
                eventType: 'status_changed',
                detail: event.detail ?? null,
                clientEventId: event.clientEventId,
                occurredAt: new Date(event.occurredAt),
                reason: reason?.code ?? null,
                metadata: {
                    previousStatus: current,
                    status: 'incident',
                    occurredAt: event.occurredAt,
                    reasonCode: reason.code,
                    ...(outboundRecordVersion !== null && { outboundRecordVersion }),
                },
            }, options);
            if (current !== 'incident') {
                const [updated]: { version: number; updated_at: Date | string }[] = await manager.query(
                    'SELECT version, updated_at FROM dispatches WHERE dispatch_id = $1', [event.dispatchId],
                );
                statusChangedEvent = {
                    dispatchId: event.dispatchId,
                    status: 'incident',
                    previousStatus: current,
                    version: updated.version,
                    updatedAt: new Date(updated.updated_at).toISOString(),
                };
            }
            return SyncEventOutcome.APPLIED;
        });
        // Emit only after the transaction commits so OTP never observes a rolled-back transition.
        if (statusChangedEvent) this.events.emit(DISPATCH_STATUS_CHANGED_EVENT, statusChangedEvent);
        if (incidentReportedEvent) this.events.emit('dispatch.incident_reported', incidentReportedEvent);
        return outcome;
    }

    /**
     * A reference the device sent that does not exist (status, incident reason...) reaches the FK and
     * used to be reported as "Unexpected error." — useless for the device, and noise in the error log.
     */
    private describeDbError(err: unknown): string | null {
        if (!(err instanceof QueryFailedError)) return null;
        const driverError = err.driverError as { code?: string; detail?: string } | undefined;
        if (driverError?.code === '23503') {
            // `lc_messages` translates the sentence ("Key (col)=(1) is not present..." / "La llave (col)=(1) no
            // está presente..."), but the column always comes as `(column)=(value)`: anchor on that, not on words.
            const column = driverError.detail?.match(/\((\w+)\)=\(/)?.[1];
            return column ? `The given ${column.replace(/_id$/, '').replace(/_/g, ' ')} does not exist.` : 'A referenced record does not exist.';
        }
        if (driverError?.code === '22003') return 'A numeric value is out of range.';
        return null;
    }

    private assertPlausibleTime(occurredAt: string): void {
        const at = new Date(occurredAt).getTime();
        const now = Date.now();
        if (at > now + MAX_FUTURE_MS || at < now - MAX_AGE_MS) {
            throw new BadRequestException('occurredAt is not plausible: it is in the future or more than 30 days old. Check the device clock.');
        }
    }

    /**
     * Offline events can arrive after the route closes, but the action must have happened while it
     * was running. This is a read-only check after locking the dispatch; never lock the batch here,
     * because the online status endpoint locks batch first and dispatch second.
     */
    private async assertWithinRouteExecution(manager: EntityManager, dispatchId: number, driverId: number, occurredAt: Date): Promise<void> {
        const [route]: { status: string; started_at: string | null; closed_at: Date | string | null }[] = await manager.query(
            `SELECT rb.status,
                    rb.closed_at,
                    started.metadata->>'startedAt' AS started_at
               FROM dispatches d
               JOIN route_batches rb ON rb.route_batch_id = d.route_batch_id
               LEFT JOIN LATERAL (
                   SELECT metadata
                     FROM route_batch_events
                    WHERE route_batch_id = rb.route_batch_id AND event_type = 'route_started'
                    ORDER BY route_batch_event_id DESC
                    LIMIT 1
               ) started ON TRUE
              WHERE d.dispatch_id = $1 AND rb.driver_id = $2`,
            [dispatchId, driverId],
        );
        const startedAt = route?.started_at ? new Date(route.started_at).getTime() : Number.NaN;
        const closedAt = route?.closed_at ? new Date(route.closed_at).getTime() : null;
        if (
            !route ||
            !['in_execution', 'closed'].includes(route.status) ||
            !Number.isFinite(startedAt) ||
            (route.status === 'closed' && (closedAt === null || !Number.isFinite(closedAt)))
        ) {
            throw new BadRequestException('The dispatch event is outside the route execution window.');
        }
        if (occurredAt.getTime() < startedAt - ROUTE_EXECUTION_CLOCK_SKEW_MS) {
            throw new BadRequestException('The dispatch event is outside the route execution window.');
        }
        if (closedAt !== null && occurredAt.getTime() > closedAt + ROUTE_EXECUTION_CLOCK_SKEW_MS) {
            throw new BadRequestException('The dispatch event is outside the route execution window.');
        }
    }

    private toFailedResult(clientEventId: string, err: unknown): SyncEventResultDto {
        const known   = this.describeDbError(err);
        const message = err instanceof HttpException
            ? ((err.getResponse() as { message?: string })?.message ?? err.message)
            : (known ?? 'Unexpected error.');
        if (!(err instanceof HttpException) && !known) this.logger.error(`Sync event ${clientEventId} failed`, err as Error);
        return { clientEventId, outcome: SyncEventOutcome.FAILED, error: message };
    }
}
