/// <reference types="multer" />
import { BadRequestException, HttpException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryFailedError } from 'typeorm';
import { DispatchEventsService } from '../../../modules/dispatch/dispatch-events/services/dispatch-events.service.js';
import { DispatchIncidentsService } from '../../../modules/dispatch/dispatch-incidents/services/dispatch-incidents.service.js';
import { DeliveryEvidencesService } from '../../../modules/dispatch/delivery-evidences/services/delivery-evidences.service.js';
import { DispatchesService } from '../../../modules/dispatch/dispatches/services/dispatches.service.js';
import { DispatchNotFoundException } from '../../../modules/dispatch/dispatches/exceptions/index.js';
import { StoragePort } from '../../../plugins/storage/storage.port.js';
import { FINAL_STATUSES } from '../../../modules/dispatch/dispatches/services/dispatches.service.js';
import { SyncEventDto } from '../dto/sync-event.dto.js';
import { SyncEventType } from '../dto/sync-event-type.enum.js';
import { SyncEventOutcome, SyncEventResultDto, SyncEventsBatchResultDto } from '../dto/sync-event-result.dto.js';
import { SyncEvidenceDto } from '../dto/sync-evidence.dto.js';

// A device clock is never exact, but an event from 2099 or from last year is not a real one: it would
// corrupt the history (and every report built on it).
const MAX_FUTURE_MS = 60 * 60 * 1000;
const MAX_AGE_MS    = 30 * 24 * 60 * 60 * 1000;

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
            if (await this.deliveryEvidencesService.existsById(dto.clientEventId)) {
                return { clientEventId: dto.clientEventId, outcome: SyncEventOutcome.ALREADY_PROCESSED };
            }
            if (!(await this.dispatchesService.isAssignedToDriver(dto.dispatchId, driverId))) throw new DispatchNotFoundException();

            // A photo or a signature IS the file, and an OTP evidence IS the code: without it there is nothing to record.
            if (dto.type !== 'otp' && !file) throw new BadRequestException('A photo or signature evidence needs its file.');
            if (dto.type === 'otp' && !dto.otpCode) throw new BadRequestException('An otp evidence needs its otpCode.');

            let fileUrl: string | null = null;
            if (file) {
                const uploaded = await this.storage.upload({ buffer: file.buffer, filename: file.originalname, mimeType: file.mimetype });
                fileUrl = uploaded.url;
            }

            await this.deliveryEvidencesService.create({
                id:         dto.clientEventId,
                dispatchId: dto.dispatchId,
                type:       dto.type,
                fileUrl,
                otpCode:    dto.otpCode ?? null,
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
        return this.dataSource.transaction(async (manager) => {
            const options = { manager };

            if (event.type === SyncEventType.STATUS_CHANGE) {
                if (await this.dispatchEventsService.existsByClientEventId(event.clientEventId, options)) {
                    return SyncEventOutcome.ALREADY_PROCESSED;
                }
                this.assertPlausibleTime(event.occurredAt);

                // Unknown dispatch and someone else's dispatch answer the same: a driver cannot probe other routes.
                if (!(await this.dispatchesService.isAssignedToDriver(event.dispatchId, driverId, options))) throw new DispatchNotFoundException();
                // A finished order (delivered / returned) cannot go back: a late or duplicated event from the
                // device must not reopen it.
                const current = await this.dispatchesService.getStatusName(event.dispatchId, options);
                const target  = await this.dispatchesService.getStatusNameById(event.dispatchStatusId!, options);
                if (current && FINAL_STATUSES.includes(current) && target !== current) {
                    throw new BadRequestException(`The dispatch is already ${current}: its status cannot change.`);
                }
                await this.dispatchesService.updateStatus(event.dispatchId, event.dispatchStatusId!, options);
                await this.dispatchEventsService.create({
                    dispatchId:    event.dispatchId,
                    eventType:     'status_changed',
                    detail:        event.detail ?? null,
                    clientEventId: event.clientEventId,
                    occurredAt:    new Date(event.occurredAt),
                }, options);
                return SyncEventOutcome.APPLIED;
            }

            // INCIDENT
            if (await this.dispatchIncidentsService.existsById(event.clientEventId, options)) {
                return SyncEventOutcome.ALREADY_PROCESSED;
            }
            this.assertPlausibleTime(event.occurredAt);
            if (!(await this.dispatchesService.isAssignedToDriver(event.dispatchId, driverId, options))) throw new DispatchNotFoundException();

            await this.dispatchIncidentsService.create({
                id:               event.clientEventId,
                dispatchId:       event.dispatchId,
                incidentReasonId: event.incidentReasonId!,
                description:      event.detail ?? null,
                occurredAt:       new Date(event.occurredAt),
            }, options);
            return SyncEventOutcome.APPLIED;
        });
    }

    /**
     * A reference the device sent that does not exist (status, incident reason...) reaches the FK and
     * used to be reported as "Unexpected error." — useless for the device, and noise in the error log.
     */
    private describeDbError(err: unknown): string | null {
        if (!(err instanceof QueryFailedError)) return null;
        const driverError = err.driverError as { code?: string; detail?: string } | undefined;
        if (driverError?.code === '23503') {
            const column = driverError.detail?.match(/Key \((\w+)\)/)?.[1];
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

    private toFailedResult(clientEventId: string, err: unknown): SyncEventResultDto {
        const known   = this.describeDbError(err);
        const message = err instanceof HttpException
            ? ((err.getResponse() as { message?: string })?.message ?? err.message)
            : (known ?? 'Unexpected error.');
        if (!(err instanceof HttpException) && !known) this.logger.error(`Sync event ${clientEventId} failed`, err as Error);
        return { clientEventId, outcome: SyncEventOutcome.FAILED, error: message };
    }
}
