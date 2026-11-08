import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Dispatch } from '../entities/dispatch.entity.js';
import { DispatchEvent } from '../../dispatch-events/entities/dispatch-event.entity.js';
import { DispatchIncident } from '../../dispatch-incidents/entities/dispatch-incident.entity.js';
import { DispatchReschedule } from '../../dispatch-reschedules/entities/dispatch-reschedule.entity.js';
import { DeliveryEvidence } from '../../delivery-evidences/entities/delivery-evidence.entity.js';
import { StoragePort } from '../../../../plugins/storage/storage.port.js';
import { DispatchNotFoundException } from '../exceptions/index.js';
import type {
    DispatchDetailDto,
    DispatchDetailEventDto,
    DispatchDetailEvidenceDto,
    DispatchDetailRatingDto,
    DispatchDetailUserDto,
} from '../dto/dispatch-detail.dto.js';

/** How long a signed evidence URL works. The viewer asks the detail again when it expires. */
export const EVIDENCE_ACCESS_TTL_SECONDS = 300;

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);
const num = (value: string | number | null | undefined): number | null => (value === null || value === undefined ? null : Number(value));
// PATCH /dispatches/:id/status (ST-30.3) stores the device position as `lat`/`lng` in the event metadata.
const coordinate = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const user = (u: { id: number; fullName: string } | null | undefined): DispatchDetailUserDto | null => (u ? { id: u.id, fullName: u.fullName } : null);

interface DispatchRatingRow {
    score: number;
    comment: string | null;
    created_at: Date;
}

/**
 * RF-A09 — unified 360° view of a dispatch. A fixed number of queries (the dispatch with its
 * to-one relations and packages, plus one per child collection), never one per event or evidence.
 */
@Injectable()
export class DispatchDetailService {
    constructor(
        @InjectRepository(Dispatch) private readonly dispatches: Repository<Dispatch>,
        @InjectRepository(DispatchEvent) private readonly events: Repository<DispatchEvent>,
        @InjectRepository(DispatchIncident) private readonly incidents: Repository<DispatchIncident>,
        @InjectRepository(DispatchReschedule) private readonly reschedules: Repository<DispatchReschedule>,
        @InjectRepository(DeliveryEvidence) private readonly evidences: Repository<DeliveryEvidence>,
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly storage: StoragePort,
    ) {}

    async findDetail(id: number): Promise<DispatchDetailDto> {
        const dispatch = await this.dispatches.findOne({
            where: { id },
            relations: {
                dispatchType: true, dispatchStatus: true, deliveryZone: true, serviceLevel: true, packages: true,
                routeBatch: { driver: true, vehicle: true },
            },
            order: { packages: { id: 'ASC' } },
        });
        if (!dispatch) throw new DispatchNotFoundException();

        const [events, incidents, reschedules, evidences, ratingRows] = await Promise.all([
            this.events.find({ where: { dispatchId: id }, relations: { actorUser: true }, order: { createdAt: 'ASC', id: 'ASC' } }),
            this.incidents.find({ where: { dispatchId: id }, relations: { incidentReason: true }, order: { createdAt: 'ASC', id: 'ASC' } }),
            this.reschedules.find({ where: { dispatchId: id }, relations: { rescheduleReason: true, rescheduledByUser: true }, order: { createdAt: 'ASC', id: 'ASC' } }),
            this.evidences.find({ where: { dispatchId: id }, order: { createdAt: 'ASC', id: 'ASC' } }),
            this.dataSource.query('SELECT score, comment, created_at FROM dispatch_ratings WHERE dispatch_id = $1', [id]),
        ]);

        const evidenceDtos = await Promise.all(evidences.map((e) => this.toEvidence(e)));
        const batch = dispatch.routeBatch;
        const ratingRow = (ratingRows as DispatchRatingRow[])[0];
        const rating: DispatchDetailRatingDto | null = ratingRow ? {
            score: Number(ratingRow.score),
            comment: ratingRow.comment,
            createdAt: new Date(ratingRow.created_at).toISOString(),
        } : null;

        return {
            id: dispatch.id,
            trackingCode: dispatch.trackingCode,
            sourceOrderRef: dispatch.sourceOrderRef,
            type: { id: dispatch.dispatchType.id, name: dispatch.dispatchType.name },
            status: { id: dispatch.dispatchStatus.id, name: dispatch.dispatchStatus.name },
            priority: dispatch.priority,
            serviceLevel: dispatch.serviceLevel ? { id: dispatch.serviceLevel.id, name: dispatch.serviceLevel.name } : null,
            evidencePolicy: dispatch.evidencePolicy,
            paymentStatusLabel: dispatch.paymentStatusLabel,
            scheduledWindowStart: iso(dispatch.scheduledWindowStart),
            scheduledWindowEnd: iso(dispatch.scheduledWindowEnd),
            createdAt: dispatch.createdAt.toISOString(),
            destination: {
                address: dispatch.deliveryAddress,
                reference: dispatch.deliveryReference,
                latitude: num(dispatch.deliveryLatitude),
                longitude: num(dispatch.deliveryLongitude),
                contactName: dispatch.contactName,
                contactPhone: dispatch.contactPhone,
                zone: dispatch.deliveryZone ? { id: dispatch.deliveryZone.id, name: dispatch.deliveryZone.name } : null,
            },
            packages: dispatch.packages.map((p) => ({
                id: p.id, externalPackageId: p.externalPackageId,
                lengthCm: p.lengthCm, widthCm: p.widthCm, heightCm: p.heightCm,
                grossWeightKg: p.grossWeightKg, handlingConditions: p.handlingConditions,
            })),
            route: batch ? {
                id: batch.id, status: batch.status, shiftDate: batch.shiftDate, sequenceOrder: dispatch.sequenceOrder,
                driver: user(batch.driver),
                vehicle: batch.vehicle ? { id: batch.vehicle.id, plate: batch.vehicle.plate, type: batch.vehicle.type, model: batch.vehicle.model } : null,
            } : null,
            receiver: evidenceDtos.find((e) => e.type === 'signature' && e.receiverName) ?? null,
            rating,
            timeline: events.map((e) => this.toEvent(e)),
            incidents: incidents.map((i) => ({
                id: i.id, reasonCode: i.incidentReason.code, reasonName: i.incidentReason.name,
                description: i.description, occurredAt: i.createdAt.toISOString(),
            })),
            reschedules: reschedules.map((r) => ({
                id: r.id, reasonCode: r.rescheduleReason.code, reasonName: r.rescheduleReason.name,
                rescheduledByType: r.rescheduledByType, rescheduledBy: user(r.rescheduledByUser),
                previousRouteBatchId: r.previousRouteBatchId, newRouteBatchId: r.newRouteBatchId,
                previousWindowStart: iso(r.previousWindowStart), previousWindowEnd: iso(r.previousWindowEnd),
                newWindowStart: iso(r.newWindowStart), newWindowEnd: iso(r.newWindowEnd),
                createdAt: r.createdAt.toISOString(),
            })),
            evidences: evidenceDtos,
        };
    }

    // Only the whitelisted keys of `metadata` leave this method: it is an internal JSON that may hold
    // other things (versions, outbound record ids) the screen must not show.
    private toEvent(e: DispatchEvent): DispatchDetailEventDto {
        const meta = e.metadata ?? {};
        const status = typeof meta.status === 'string' ? meta.status : null;
        const occurredAt = typeof meta.occurredAt === 'string' && !Number.isNaN(Date.parse(meta.occurredAt)) ? new Date(meta.occurredAt) : e.createdAt;
        return {
            id: e.id, eventType: e.eventType, detail: e.detail, status, reason: e.reason,
            occurredAt: occurredAt.toISOString(),
            latitude: coordinate(meta.lat ?? meta.latitude),
            longitude: coordinate(meta.lng ?? meta.longitude),
            actorType: e.actorType,
            operator: user(e.actorUser),
        };
    }

    private async toEvidence(e: DeliveryEvidence): Promise<DispatchDetailEvidenceDto> {
        const access = e.fileUrl ? await this.storage.getAccessUrl(e.fileUrl, EVIDENCE_ACCESS_TTL_SECONDS) : null;
        return {
            id: e.id, type: e.type,
            accessUrl: access?.url ?? null,
            accessUrlExpiresAt: access ? access.expiresAt.toISOString() : null,
            capturedAt: (e.capturedAt ?? e.createdAt).toISOString(),
            latitude: e.latitude, longitude: e.longitude,
            receiverName: e.receiverName, receiverDocument: e.receiverDocument,
        };
    }
}
