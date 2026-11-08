import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { DispatchEventsService } from '../../modules/dispatch/dispatch-events/services/dispatch-events.service.js';
import { DeliveryEvidencesService } from '../../modules/dispatch/delivery-evidences/services/delivery-evidences.service.js';
import { RegisterReturnPickupDto } from './dto/register-return-pickup.dto.js';
import { ReturnPickupResponseDto } from './dto/supplier-pickup-response.dto.js';
import {
    ReturnPickupObservationsRequiredException, ReturnPickupPhotoRequiredException,
    ReturnPickupSignatureRequiredException, SupplierPickupConflictException,
} from './exceptions/supplier-pickup.exception.js';
import { loadOwnedDispatch } from './owned-dispatch.js';

/** Discriminator in `dispatch_events.metadata`, so an eventId of another event cannot be replayed as this one. */
export const RETURN_PICKUP_COLLECTION_KIND = 'return_pickup_collection';
export const RETURN_PICKUP_DISPATCH_TYPE = 'warehouse_return_pickup';

/** ST-80.2 (RF-U23): the driver collects the returned goods at the customer's home. */
@Injectable()
export class ReturnPickupService {
    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly dispatchEvents: DispatchEventsService,
        private readonly evidences: DeliveryEvidencesService,
    ) {}

    async registerCollection(dispatchId: number, driverId: number, dto: RegisterReturnPickupDto): Promise<ReturnPickupResponseDto> {
        return await this.dataSource.transaction((manager) => this.registerCollectionIn(manager, dispatchId, driverId, dto));
    }

    private async registerCollectionIn(manager: EntityManager, dispatchId: number, driverId: number, dto: RegisterReturnPickupDto): Promise<ReturnPickupResponseDto> {
        const dispatch = await loadOwnedDispatch(manager, dispatchId, driverId);
        if (dispatch.dispatch_type !== RETURN_PICKUP_DISPATCH_TYPE) {
            throw new SupplierPickupConflictException('DISPATCH_NOT_RETURN_PICKUP', 'This endpoint only applies to a customer return pickup (warehouse_return_pickup).');
        }

        const previous = await this.dispatchEvents.findByClientEventId(dto.eventId, { manager });
        if (previous) {
            if (previous.dispatchId !== dispatchId || previous.eventType !== 'status_changed' || previous.metadata?.kind !== RETURN_PICKUP_COLLECTION_KIND) {
                throw new SupplierPickupConflictException('EVENT_ID_ALREADY_USED', 'This eventId was already used for another event.');
            }
            return {
                dispatchId,
                status: 'picked_up_in_transit',
                custodyReceivedAt: dispatch.custody_received_at ?? new Date(previous.createdAt),
                checklistComplete: previous.metadata?.checklistComplete === true,
            };
        }

        if (dispatch.status !== 'in_transit') {
            throw new SupplierPickupConflictException('DISPATCH_NOT_IN_TRANSIT', 'A return pickup can only be collected while in_transit.');
        }

        const { originalPackaging, completeParts, noMisuseDamage } = dto.checklist;
        const checklistComplete = originalPackaging && completeParts && noMisuseDamage;
        const observations = dto.observations?.trim() ?? '';
        if (!checklistComplete && observations === '') throw new ReturnPickupObservationsRequiredException();

        const photo = await this.evidences.findById(dto.photoId, { manager });
        if (!photo || photo.dispatchId !== dispatchId || photo.type !== 'photo' || !photo.fileUrl?.trim()) {
            throw new ReturnPickupPhotoRequiredException();
        }
        const signature = await this.evidences.findById(dto.signatureId, { manager });
        if (!signature || signature.dispatchId !== dispatchId || signature.type !== 'signature' || !signature.fileUrl?.trim()) {
            throw new ReturnPickupSignatureRequiredException();
        }

        const occurredAt = new Date(dto.occurredAt);
        const [targetStatus]: { dispatch_status_id: number }[] = await manager.query(
            `SELECT dispatch_status_id FROM dispatch_statuses WHERE name = $1`, ['picked_up_in_transit'],
        );
        const [updated]: { custody_received_at: Date }[] = await manager.query(
            `WITH updated AS (
                UPDATE dispatches
                   SET dispatch_status_id = $1, custody_received_at = $2::timestamptz, updated_at = NOW()
                 WHERE dispatch_id = $3
             RETURNING custody_received_at
             )
             SELECT custody_received_at FROM updated`,
            [targetStatus.dispatch_status_id, occurredAt, dispatchId],
        );

        await this.dispatchEvents.create({
            dispatchId,
            eventType: 'status_changed',
            detail: 'in_transit -> picked_up_in_transit',
            clientEventId: dto.eventId,
            actorUserId: driverId,
            actorType: 'user',
            reason: checklistComplete ? 'Driver collected the returned goods at the customer' : 'Driver collected the returned goods with an incomplete checklist',
            metadata: {
                kind: RETURN_PICKUP_COLLECTION_KIND,
                previousStatus: 'in_transit', status: 'picked_up_in_transit',
                checklist: dto.checklist, checklistComplete,
                ...(observations !== '' && { observations }),
                photoId: dto.photoId, signatureId: dto.signatureId,
                lat: dto.lat, lng: dto.lng, accuracy: dto.accuracy,
            },
            occurredAt,
        }, { manager });

        return { dispatchId, status: 'picked_up_in_transit', custodyReceivedAt: updated.custody_received_at, checklistComplete };
    }
}
