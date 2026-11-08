import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { buildEnvelope } from '../../plugins/messaging/envelope/message-envelope.js';
import { OutboxService } from '../../modules/messaging/outbound-messages/services/outbox.service.js';
import { DispatchEventsService } from '../../modules/dispatch/dispatch-events/services/dispatch-events.service.js';
import { DeliveryEvidencesService } from '../../modules/dispatch/delivery-evidences/services/delivery-evidences.service.js';
import { DispatchIncidentsService } from '../../modules/dispatch/dispatch-incidents/services/dispatch-incidents.service.js';
import { loadOwnedDispatch } from './owned-dispatch.js';
import { IncidentReasonNotFoundException } from '../../modules/catalog/incident-reasons/exceptions/incident-reason-not-found.exception.js';
import { DispatchStatusPublicationService } from '../../modules/dispatch/dispatch-status-publication/dispatch-status-publication.service.js';
import { RegisterSupplierPickupDto } from './dto/register-supplier-pickup.dto.js';
import { ArrivedAtWarehouseDto } from './dto/arrived-at-warehouse.dto.js';
import { ArrivedAtWarehouseResponseDto, SupplierPickupResponseDto } from './dto/supplier-pickup-response.dto.js';
import { SupplierPickupConflictException, SupplierPickupEvidenceRequiredException, SupplierPickupSignatureRequiredException } from './exceptions/supplier-pickup.exception.js';

const DISPATCH_TRANSFER_INCIDENT_REPORTED_TOPIC = 'dispatch.transfer.incident_reported';

// Both endpoints write dispatch_events with the same eventType ('status_changed'); this
// discriminator in metadata stops an eventId issued by one from being replayed as a valid
// idempotent retry of the other.
const SUPPLIER_PICKUP_COLLECTION_KIND = 'supplier_pickup_collection';
const WAREHOUSE_ARRIVAL_KIND = 'warehouse_arrival';

interface ExpectedItemRow { item_code: string; expected_quantity: string; }
interface ReasonRow { incident_reason_id: number; code: string; }

@Injectable()
export class SupplierPickupService {
    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly dispatchEvents: DispatchEventsService,
        private readonly evidences: DeliveryEvidencesService,
        private readonly incidents: DispatchIncidentsService,
        private readonly statusPublication: DispatchStatusPublicationService,
        private readonly outbox: OutboxService,
    ) {}

    async registerCollection(dispatchId: number, driverId: number, dto: RegisterSupplierPickupDto): Promise<SupplierPickupResponseDto> {
        return await this.dataSource.transaction((manager) => this.registerCollectionIn(manager, dispatchId, driverId, dto));
    }

    async registerArrival(dispatchId: number, driverId: number, dto: ArrivedAtWarehouseDto): Promise<ArrivedAtWarehouseResponseDto> {
        return await this.dataSource.transaction((manager) => this.registerArrivalIn(manager, dispatchId, driverId, dto));
    }

    private async registerCollectionIn(
        manager: EntityManager,
        dispatchId: number,
        driverId: number,
        dto: RegisterSupplierPickupDto,
    ): Promise<SupplierPickupResponseDto> {
        const dispatch = await loadOwnedDispatch(manager, dispatchId, driverId);
        if (dispatch.dispatch_type !== 'supplier_pickup') {
            throw new SupplierPickupConflictException('DISPATCH_NOT_SUPPLIER_PICKUP', 'This endpoint only applies to a supplier pickup.');
        }

        const previous = await this.dispatchEvents.findByClientEventId(dto.eventId, { manager });
        if (previous) {
            if (previous.dispatchId !== dispatchId || previous.eventType !== 'status_changed' || previous.metadata?.kind !== SUPPLIER_PICKUP_COLLECTION_KIND) {
                throw new SupplierPickupConflictException('EVENT_ID_ALREADY_USED', 'This eventId was already used for another event.');
            }
            return {
                dispatchId,
                status: 'picked_up_in_transit',
                custodyReceivedAt: dispatch.custody_received_at ?? new Date(previous.createdAt),
                hasDiscrepancy: typeof previous.metadata?.reasonCode === 'string',
            };
        }

        if (dispatch.status !== 'in_transit') {
            throw new SupplierPickupConflictException('DISPATCH_NOT_IN_TRANSIT', 'A supplier pickup can only be collected while in_transit.');
        }

        const signature = await this.evidences.findById(dto.signatureId, { manager });
        if (!signature || signature.dispatchId !== dispatchId || signature.type !== 'signature' || !signature.fileUrl?.trim()) {
            throw new SupplierPickupSignatureRequiredException();
        }

        const expected: ExpectedItemRow[] = await manager.query(
            `SELECT item_code, expected_quantity FROM dispatch_pickup_items WHERE dispatch_id = $1 FOR UPDATE`,
            [dispatchId],
        );
        const expectedByCode = new Map(expected.map((row) => [row.item_code, Number(row.expected_quantity)]));
        const receivedCodes = new Set(dto.items.map((item) => item.itemCode));
        if (receivedCodes.size !== dto.items.length || receivedCodes.size !== expectedByCode.size
            || dto.items.some((item) => !expectedByCode.has(item.itemCode))) {
            throw new SupplierPickupConflictException('SUPPLIER_PICKUP_ITEMS_MISMATCH', 'items must match exactly the items expected for this pickup, no duplicates.');
        }

        const hasDiscrepancy = dto.items.some((item) => item.receivedQuantity !== expectedByCode.get(item.itemCode));
        let reason: ReasonRow | undefined;
        if (hasDiscrepancy) {
            if (!dto.reasonCode || !dto.photoId) throw new SupplierPickupEvidenceRequiredException();
            const evidence = await this.evidences.findById(dto.photoId, { manager });
            if (!evidence || evidence.dispatchId !== dispatchId || evidence.type !== 'photo' || !evidence.fileUrl?.trim()) {
                throw new SupplierPickupEvidenceRequiredException();
            }
            const [foundReason]: ReasonRow[] = await manager.query(
                `SELECT incident_reason_id, code FROM incident_reasons WHERE code = $1 AND active = TRUE AND deleted_at IS NULL`,
                [dto.reasonCode],
            );
            if (!foundReason) throw new IncidentReasonNotFoundException();
            reason = foundReason;
        }

        for (const item of dto.items) {
            await manager.query(
                `UPDATE dispatch_pickup_items SET received_quantity = $1, updated_at = NOW() WHERE dispatch_id = $2 AND item_code = $3`,
                [item.receivedQuantity, dispatchId, item.itemCode],
            );
        }

        const occurredAt = new Date(dto.occurredAt);
        const [targetStatus]: { dispatch_status_id: number }[] = await manager.query(
            `SELECT dispatch_status_id FROM dispatch_statuses WHERE name = $1`, ['picked_up_in_transit'],
        );
        const [updated]: { custody_received_at: Date }[] = await manager.query(
            `WITH updated AS (
                UPDATE dispatches
                   SET dispatch_status_id = $1, received_boxes = $2, custody_received_at = $3::timestamptz, updated_at = NOW()
                 WHERE dispatch_id = $4
             RETURNING custody_received_at
             )
             SELECT custody_received_at FROM updated`,
            [targetStatus.dispatch_status_id, dto.receivedBoxes, occurredAt, dispatchId],
        );

        const outboundRecordVersion = await this.statusPublication.publishTransferUpdate(manager, {
            dispatchId,
            status: 'picked_up_in_transit',
            previousStatus: 'in_transit',
            occurredAt,
        });

        await this.dispatchEvents.create({
            dispatchId,
            eventType: 'status_changed',
            detail: 'in_transit -> picked_up_in_transit',
            clientEventId: dto.eventId,
            actorUserId: driverId,
            actorType: 'user',
            reason: hasDiscrepancy ? 'Driver confirmed supplier pickup with a quantity difference' : 'Driver confirmed supplier pickup',
            metadata: {
                kind: SUPPLIER_PICKUP_COLLECTION_KIND,
                previousStatus: 'in_transit', status: 'picked_up_in_transit',
                receivedBoxes: dto.receivedBoxes, items: dto.items,
                outboundRecordVersion,
                lat: dto.lat, lng: dto.lng, accuracy: dto.accuracy,
                ...(hasDiscrepancy && { reasonCode: dto.reasonCode, photoId: dto.photoId }),
            },
            occurredAt,
        }, { manager });

        if (hasDiscrepancy && reason) {
            const incidentId = uuidv7();
            await this.incidents.create({
                id: incidentId,
                dispatchId,
                incidentReasonId: reason.incident_reason_id,
                description: `Supplier pickup quantity difference: ${JSON.stringify(dto.items)}`,
                occurredAt,
            }, { manager });
            await this.outbox.enqueue(buildEnvelope({
                type: DISPATCH_TRANSFER_INCIDENT_REPORTED_TOPIC,
                source: 'dispatch',
                occurredAt,
                data: {
                    purchaseOrderId: dispatch.source_order_ref,
                    trackingCode: dispatch.tracking_code,
                    incidentId,
                    reasonCode: reason.code,
                    reportedAt: occurredAt.toISOString(),
                    nextStep: 'continue',
                    recordVersion: outboundRecordVersion,
                    updatedAt: occurredAt.toISOString(),
                },
            }), { manager });
        }

        return { dispatchId, status: 'picked_up_in_transit', custodyReceivedAt: updated.custody_received_at, hasDiscrepancy };
    }

    private async registerArrivalIn(
        manager: EntityManager,
        dispatchId: number,
        driverId: number,
        dto: ArrivedAtWarehouseDto,
    ): Promise<ArrivedAtWarehouseResponseDto> {
        const dispatch = await loadOwnedDispatch(manager, dispatchId, driverId);
        if (dispatch.dispatch_type !== 'supplier_pickup') {
            throw new SupplierPickupConflictException('DISPATCH_NOT_SUPPLIER_PICKUP', 'This endpoint only applies to a supplier pickup.');
        }

        const previous = await this.dispatchEvents.findByClientEventId(dto.eventId, { manager });
        if (previous) {
            if (previous.dispatchId !== dispatchId || previous.eventType !== 'status_changed' || previous.metadata?.kind !== WAREHOUSE_ARRIVAL_KIND) {
                throw new SupplierPickupConflictException('EVENT_ID_ALREADY_USED', 'This eventId was already used for another event.');
            }
            return { dispatchId, arrivedAtWarehouseAt: dispatch.arrived_at_warehouse_at ?? new Date(previous.createdAt) };
        }

        if (dispatch.status !== 'picked_up_in_transit') {
            throw new SupplierPickupConflictException('DISPATCH_NOT_PICKED_UP', 'The warehouse arrival can only be registered after the pickup was collected.');
        }
        if (dispatch.arrived_at_warehouse_at !== null) {
            throw new SupplierPickupConflictException('WAREHOUSE_ARRIVAL_ALREADY_REGISTERED', 'The arrival at the warehouse was already registered for this dispatch.');
        }

        const occurredAt = new Date(dto.occurredAt);
        const [updated]: { arrived_at_warehouse_at: Date }[] = await manager.query(
            `WITH updated AS (
                UPDATE dispatches SET arrived_at_warehouse_at = $1::timestamptz, updated_at = NOW()
                 WHERE dispatch_id = $2
             RETURNING arrived_at_warehouse_at
             )
             SELECT arrived_at_warehouse_at FROM updated`,
            [occurredAt, dispatchId],
        );

        // Status does not change here; the message is still dispatch.transfer.status_changed (informative only).
        const outboundRecordVersion = await this.statusPublication.publishTransferUpdate(manager, {
            dispatchId,
            status: 'picked_up_in_transit',
            previousStatus: 'picked_up_in_transit',
            occurredAt,
        });

        await this.dispatchEvents.create({
            dispatchId,
            eventType: 'status_changed',
            detail: 'arrived_at_warehouse',
            clientEventId: dto.eventId,
            actorUserId: driverId,
            actorType: 'user',
            reason: 'Driver arrived at the destination warehouse',
            metadata: {
                kind: WAREHOUSE_ARRIVAL_KIND,
                previousStatus: 'picked_up_in_transit', status: 'picked_up_in_transit',
                arrivedAtWarehouseAt: occurredAt.toISOString(), outboundRecordVersion,
                lat: dto.lat, lng: dto.lng, accuracy: dto.accuracy,
            },
            occurredAt,
        }, { manager });

        return { dispatchId, arrivedAtWarehouseAt: updated.arrived_at_warehouse_at };
    }
}
