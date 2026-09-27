import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BaseCreatedUpdated } from '../../../../database/entities/base.entity.js';
import { numericTransformer } from '../../../../shared/orm/index.js';
import { DispatchType } from '../../dispatch-types/entities/dispatch-type.entity.js';
import { DispatchStatus } from '../../dispatch-statuses/entities/dispatch-status.entity.js';
import { DeliveryZone } from '../../../catalog/delivery-zones/entities/delivery-zone.entity.js';
import { ServiceLevel } from '../../../catalog/service-levels/entities/service-level.entity.js';
import { RouteBatch } from '../../route-batches/entities/route-batch.entity.js';

@Entity('dispatches')
export class Dispatch extends BaseCreatedUpdated {
    @PrimaryGeneratedColumn({ name: 'dispatch_id' })
    id: number;

    @Column({ name: 'dispatch_type_id', type: 'int' })
    dispatchTypeId: number;

    @Column({ name: 'dispatch_status_id', type: 'int' })
    dispatchStatusId: number;

    // Only applies to delivery / warehouse_return_pickup.
    @Column({ name: 'delivery_zone_id', type: 'int', nullable: true })
    deliveryZoneId: number | null;

    @Column({ name: 'service_level_id', type: 'int', nullable: true })
    serviceLevelId: number | null;

    // NULL until the coordinator assigns it to a route.
    @Column({ name: 'route_batch_id', type: 'int', nullable: true })
    routeBatchId: number | null;

    // Visit order within its route_batch, calculated by OSRM.
    @Column({ name: 'sequence_order', type: 'smallint', nullable: true })
    sequenceOrder: number | null;

    // Order/request reference in the origin system (Almacén or Compras y Proveedores).
    @Column({ name: 'source_order_ref', type: 'varchar', length: 100 })
    sourceOrderRef: string;

    @Column({ name: 'priority', type: 'varchar', length: 10, default: 'normal' })
    priority: string;

    @Column({ name: 'delivery_address', type: 'text' })
    deliveryAddress: string;

    @Column({ name: 'delivery_latitude', type: 'numeric', precision: 9, scale: 6, nullable: true })
    deliveryLatitude: string | null;

    @Column({ name: 'delivery_longitude', type: 'numeric', precision: 9, scale: 6, nullable: true })
    deliveryLongitude: string | null;

    @Column({ name: 'contact_name', type: 'varchar', length: 150, nullable: true })
    contactName: string | null;

    @Column({ name: 'contact_phone', type: 'varchar', length: 30, nullable: true })
    contactPhone: string | null;

    @Column({ name: 'contact_email', type: 'varchar', length: 150, nullable: true })
    contactEmail: string | null;

    // Read-only informational label from the origin system (e.g. "Prepaid") — Despachos doesn't manage payments.
    @Column({ name: 'payment_status_label', type: 'varchar', length: 50, nullable: true })
    paymentStatusLabel: string | null;

    // Read-only, from the origin system — Despachos doesn't manage inventory.
    @Column({ name: 'package_contents', type: 'text', nullable: true })
    packageContents: string | null;

    @Column({ name: 'estimated_weight_kg', type: 'numeric', precision: 10, scale: 2, nullable: true })
    estimatedWeightKg: string | null;

    // Only applies to warehouse_return_pickup / supplier_return.
    @Column({ name: 'return_reason', type: 'text', nullable: true })
    returnReason: string | null;

    @Column({ name: 'scheduled_window_start', type: 'timestamptz', nullable: true })
    scheduledWindowStart: Date | null;

    @Column({ name: 'scheduled_window_end', type: 'timestamptz', nullable: true })
    scheduledWindowEnd: Date | null;

    // Moment the origin confirmed the package/cargo is physically ready for pickup.
    @Column({ name: 'package_ready_at', type: 'timestamptz', nullable: true })
    packageReadyAt: Date | null;

    @Column({ name: 'tracking_token', type: 'varchar', length: 100, nullable: true, unique: true })
    trackingToken: string | null;

    @Column({ name: 'tracking_token_expires_at', type: 'timestamptz', nullable: true })
    trackingTokenExpiresAt: Date | null;

    // Written by app/tracking (RF-U11) — numericTransformer so the API round-trips a plain number,
    // not the "1.234560" string pg returns for NUMERIC. Only these two fields get it here: the rest
    // of this entity's NUMERIC columns predate the convention (see ST-22.1) and are out of this ticket's scope.
    @Column({ name: 'last_latitude', type: 'numeric', precision: 9, scale: 6, nullable: true, transformer: numericTransformer })
    lastLatitude: number | null;

    @Column({ name: 'last_longitude', type: 'numeric', precision: 9, scale: 6, nullable: true, transformer: numericTransformer })
    lastLongitude: number | null;

    @Column({ name: 'last_location_at', type: 'timestamptz', nullable: true })
    lastLocationAt: Date | null;

    @Column({ name: 'confirmed_at', type: 'timestamptz', nullable: true })
    confirmedAt: Date | null;

    @ManyToOne(() => DispatchType)
    @JoinColumn({ name: 'dispatch_type_id' })
    dispatchType: DispatchType;

    @ManyToOne(() => DispatchStatus)
    @JoinColumn({ name: 'dispatch_status_id' })
    dispatchStatus: DispatchStatus;

    @ManyToOne(() => DeliveryZone)
    @JoinColumn({ name: 'delivery_zone_id' })
    deliveryZone: DeliveryZone | null;

    @ManyToOne(() => ServiceLevel)
    @JoinColumn({ name: 'service_level_id' })
    serviceLevel: ServiceLevel | null;

    @ManyToOne(() => RouteBatch)
    @JoinColumn({ name: 'route_batch_id' })
    routeBatch: RouteBatch | null;
}
