import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { DeliveryEvidencesService } from '../../modules/dispatch/delivery-evidences/services/delivery-evidences.service.js';
import { DispatchEventsService } from '../../modules/dispatch/dispatch-events/services/dispatch-events.service.js';
import { DispatchIncidentsService } from '../../modules/dispatch/dispatch-incidents/services/dispatch-incidents.service.js';
import { DispatchNotFoundException } from '../../modules/dispatch/dispatches/exceptions/dispatch-not-found.exception.js';
import { IncidentReasonNotFoundException } from '../../modules/catalog/incident-reasons/exceptions/incident-reason-not-found.exception.js';
import { DispatchIncidentResponseDto } from './dto/dispatch-incident-response.dto.js';
import { CreateDispatchIncidentDto } from './dto/create-dispatch-incident.dto.js';
import { COMPANY_FAILURE_REASON, INCIDENT_REPORTED_EVENT, assertPlausibleIncidentTime, requiresIncidentObservations } from './domain/incident-report.js';
import { IncidentCaptureTimeInvalidException, IncidentEvidenceRequiredException, IncidentObservationsInvalidException, IncidentReportConflictException } from './exceptions/incident-report.exception.js';

interface DispatchIdentity { route_batch_id: number | null; }
interface RouteIdentity { route_batch_id: number; driver_id: number | null; }
interface DispatchRow { dispatch_id: number; route_batch_id: number | null; delivery_zone_id: number | null; status: string; }
interface ReasonRow { incident_reason_id: number; code: string; name: string; active: boolean; requires_evidence: boolean; counts_as_attempt: boolean; }
interface ExistingIncident { dispatch_id: number; reason_code: string; description: string | null; created_at: Date; metadata: Record<string, unknown> | null; }

interface ReportOutcome { response: DispatchIncidentResponseDto; created: boolean; event?: Record<string, unknown>; }

@Injectable()
export class DispatchIncidentsAppService {
    private readonly logger = new Logger(DispatchIncidentsAppService.name);

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly incidents: DispatchIncidentsService,
        private readonly evidences: DeliveryEvidencesService,
        private readonly dispatchEvents: DispatchEventsService,
        private readonly events: EventEmitter2,
    ) {}

    async report(dispatchId: number, driverId: number, dto: CreateDispatchIncidentDto): Promise<{ incident: DispatchIncidentResponseDto; created: boolean }> {
        const occurredAt = new Date(dto.occurredAt);
        try { assertPlausibleIncidentTime(occurredAt, new Date()); }
        catch { throw new IncidentCaptureTimeInvalidException(); }
        const outcome = await this.dataSource.transaction(async (manager) => this.reportInTransaction(manager, dispatchId, driverId, dto, occurredAt));

        // Socket publication follows commit. A replay never emits a second alert.
        if (outcome.event) {
            try { this.events.emit(INCIDENT_REPORTED_EVENT, outcome.event); }
            catch (error) { this.logger.error(`Incident ${dto.incidentId} was committed but its alert could not be queued.`, error as Error); }
        }
        return { incident: outcome.response, created: outcome.created };
    }

    private async reportInTransaction(manager: EntityManager, dispatchId: number, driverId: number, dto: CreateDispatchIncidentDto, occurredAt: Date): Promise<ReportOutcome> {
        // Serialize duplicate requests globally by their client-generated incident UUID.
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`dispatch-incident:${dto.incidentId}`]);

        const [identity]: DispatchIdentity[] = await manager.query('SELECT route_batch_id FROM dispatches WHERE dispatch_id = $1', [dispatchId]);
        if (!identity) throw new DispatchNotFoundException();
        if (identity.route_batch_id === null) throw new ForbiddenException({ message: 'Dispatch is not assigned to your route.', error: 'INSUFFICIENT_PERMISSIONS' });

        // Match the lock order used by the driver status endpoint to avoid route/dispatch deadlocks.
        const [route]: RouteIdentity[] = await manager.query(
            'SELECT route_batch_id, driver_id FROM route_batches WHERE route_batch_id = $1 FOR UPDATE',
            [identity.route_batch_id],
        );
        const [dispatch]: DispatchRow[] = await manager.query(
            `SELECT d.dispatch_id, d.route_batch_id, d.delivery_zone_id, ds.name AS status
               FROM dispatches d JOIN dispatch_statuses ds ON ds.dispatch_status_id = d.dispatch_status_id
              WHERE d.dispatch_id = $1 FOR UPDATE OF d`,
            [dispatchId],
        );
        if (!dispatch) throw new DispatchNotFoundException();
        if (!route || route.driver_id !== driverId || route.route_batch_id !== identity.route_batch_id || dispatch.route_batch_id !== route.route_batch_id) {
            throw new ForbiddenException({ message: 'Dispatch is not assigned to your route.', error: 'INSUFFICIENT_PERMISSIONS' });
        }

        const [existing]: ExistingIncident[] = await manager.query(
            `SELECT i.dispatch_id, r.code AS reason_code, i.description, i.created_at, e.metadata
               FROM dispatch_incidents i
               JOIN incident_reasons r ON r.incident_reason_id = i.incident_reason_id
          LEFT JOIN dispatch_events e ON e.dispatch_id = i.dispatch_id AND e.client_event_id = i.dispatch_incident_id
              WHERE i.dispatch_incident_id = $1`,
            [dto.incidentId],
        );
        if (existing) {
            if (existing.dispatch_id !== dispatchId) throw new IncidentReportConflictException('INCIDENT_ID_CONFLICT', 'This incidentId already belongs to another dispatch.');
            if (!this.matchesExisting(existing, dto, occurredAt)) throw new IncidentReportConflictException('INCIDENT_ID_CONFLICT', 'This incidentId was already used with different incident data.');
            return { response: this.toResponse(dispatchId, dto.incidentId, existing.reason_code, existing.created_at, existing.metadata), created: false };
        }

        if (dispatch.status !== 'in_transit') throw new IncidentReportConflictException('DISPATCH_NOT_IN_TRANSIT', 'An incident can only be reported for an in-transit dispatch.');

        const [reason]: ReasonRow[] = await manager.query(
            `SELECT incident_reason_id, code, name, active, requires_evidence, counts_as_attempt
               FROM incident_reasons WHERE code = $1 AND active = TRUE AND deleted_at IS NULL`,
            [dto.reasonCode],
        );
        if (!reason) throw new IncidentReasonNotFoundException();
        if (requiresIncidentObservations(reason.name) && dto.observations.trim().length < 10) {
            throw new IncidentObservationsInvalidException();
        }

        const companyFailure = reason.code === COMPANY_FAILURE_REASON;
        const needsPhoto = !companyFailure && reason.requires_evidence;
        if (!dto.evidenceId && needsPhoto) throw new IncidentEvidenceRequiredException();
        if (dto.evidenceId) {
            const evidence = await this.evidences.findById(dto.evidenceId, { manager });
            if (!evidence || evidence.dispatchId !== dispatchId || evidence.type !== 'photo' || !evidence.fileUrl?.trim()) {
                throw new IncidentEvidenceRequiredException();
            }
        }

        const [targetStatus]: { dispatch_status_id: number }[] = await manager.query(
            'SELECT dispatch_status_id FROM dispatch_statuses WHERE name = $1', ['incident'],
        );
        if (!targetStatus) throw new BadRequestException({ message: 'The incident dispatch status is not configured.', error: 'DISPATCH_STATUS_UNKNOWN' });

        const reportedAt = new Date();
        await this.incidents.create({ id: dto.incidentId, dispatchId, incidentReasonId: reason.incident_reason_id, description: dto.observations, occurredAt }, { manager });
        await manager.query(
            'UPDATE dispatches SET dispatch_status_id = $1, updated_at = NOW() WHERE dispatch_id = $2',
            [targetStatus.dispatch_status_id, dispatchId],
        );
        await this.dispatchEvents.create({
            dispatchId,
            eventType: 'status_changed',
            detail: dto.observations,
            clientEventId: dto.incidentId,
            occurredAt,
            actorUserId: driverId,
            actorType: 'user',
            reason: reason.code,
            metadata: {
                previousStatus: 'in_transit', status: 'incident', reasonCode: reason.code,
                occurredAt: occurredAt.toISOString(), lat: dto.lat, lng: dto.lng,
                ...(dto.evidenceId && { evidenceId: dto.evidenceId }), reportedAt: reportedAt.toISOString(),
            },
        }, { manager });

        const response = this.toResponse(dispatchId, dto.incidentId, reason.code, reportedAt, {
            occurredAt: occurredAt.toISOString(), lat: dto.lat, lng: dto.lng,
            ...(dto.evidenceId && { evidenceId: dto.evidenceId }), reportedAt: reportedAt.toISOString(),
        });
        return {
            response,
            created: true,
            event: {
                dispatchId, incidentId: dto.incidentId, reasonCode: reason.code,
                reportedAt: reportedAt.toISOString(),
                criticality: 'high',
            },
        };
    }

    private toResponse(dispatchId: number, incidentId: string, reasonCode: string, fallbackTime: Date, metadata: Record<string, unknown> | null): DispatchIncidentResponseDto {
        return {
            dispatchId,
            incidentId,
            reasonCode,
            status: 'incident',
            reportedAt: typeof metadata?.reportedAt === 'string' ? metadata.reportedAt : fallbackTime.toISOString(),
        };
    }

    private matchesExisting(existing: ExistingIncident, dto: CreateDispatchIncidentDto, occurredAt: Date): boolean {
        const metadata = existing.metadata;
        return existing.reason_code === dto.reasonCode && existing.description === dto.observations &&
            new Date(existing.created_at).getTime() === occurredAt.getTime() &&
            Number(metadata?.lat) === dto.lat && Number(metadata?.lng) === dto.lng &&
            (metadata?.evidenceId ?? undefined) === dto.evidenceId;
    }
}
