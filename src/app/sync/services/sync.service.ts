/// <reference types="multer" />
import { HttpException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DispatchEventsService } from '../../../modules/dispatch/dispatch-events/services/dispatch-events.service.js';
import { DispatchIncidentsService } from '../../../modules/dispatch/dispatch-incidents/services/dispatch-incidents.service.js';
import { DeliveryEvidencesService } from '../../../modules/dispatch/delivery-evidences/services/delivery-evidences.service.js';
import { DispatchesService } from '../../../modules/dispatch/dispatches/services/dispatches.service.js';
import { DispatchNotFoundException } from '../../../modules/dispatch/dispatches/exceptions/index.js';
import { StoragePort } from '../../../plugins/storage/storage.port.js';
import { SyncEventDto } from '../dto/sync-event.dto.js';
import { SyncEventType } from '../dto/sync-event-type.enum.js';
import { SyncEventOutcome, SyncEventResultDto, SyncEventsBatchResultDto } from '../dto/sync-event-result.dto.js';
import { SyncEvidenceDto } from '../dto/sync-evidence.dto.js';

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
    async processBatch(events: SyncEventDto[]): Promise<SyncEventsBatchResultDto> {
        const results: SyncEventResultDto[] = [];
        for (const event of events) {
            results.push(await this.processOneSafely(event));
        }
        return { results };
    }

    async syncEvidence(dto: SyncEvidenceDto, file?: Express.Multer.File): Promise<SyncEventResultDto> {
        try {
            if (await this.deliveryEvidencesService.existsById(dto.clientEventId)) {
                return { clientEventId: dto.clientEventId, outcome: SyncEventOutcome.ALREADY_PROCESSED };
            }
            if (!(await this.dispatchesService.existsById(dto.dispatchId))) throw new DispatchNotFoundException();

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

    private async processOneSafely(event: SyncEventDto): Promise<SyncEventResultDto> {
        try {
            const outcome = await this.processOne(event);
            return { clientEventId: event.clientEventId, outcome };
        } catch (err) {
            return this.toFailedResult(event.clientEventId, err);
        }
    }

    private async processOne(event: SyncEventDto): Promise<SyncEventOutcome> {
        return this.dataSource.transaction(async (manager) => {
            const options = { manager };

            if (event.type === SyncEventType.STATUS_CHANGE) {
                if (await this.dispatchEventsService.existsByClientEventId(event.clientEventId, options)) {
                    return SyncEventOutcome.ALREADY_PROCESSED;
                }

                // updateStatus() itself throws DispatchNotFoundException if dispatchId doesn't exist.
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
            if (!(await this.dispatchesService.existsById(event.dispatchId, options))) throw new DispatchNotFoundException();

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

    private toFailedResult(clientEventId: string, err: unknown): SyncEventResultDto {
        const message = err instanceof HttpException
            ? ((err.getResponse() as { message?: string })?.message ?? err.message)
            : 'Unexpected error.';
        if (!(err instanceof HttpException)) this.logger.error(`Sync event ${clientEventId} failed`, err as Error);
        return { clientEventId, outcome: SyncEventOutcome.FAILED, error: message };
    }
}
