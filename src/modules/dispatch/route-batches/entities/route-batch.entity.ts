import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BaseCreatedUpdated } from '../../../../database/entities/base.entity.js';
import { User } from '../../../auth/users/entities/user.entity.js';
import { Vehicle } from '../../../fleet/vehicles/entities/vehicle.entity.js';
import { DeliveryZone } from '../../../catalog/delivery-zones/entities/delivery-zone.entity.js';
import { Warehouse } from '../../../catalog/warehouses/entities/warehouse.entity.js';

@Entity('route_batches')
export class RouteBatch extends BaseCreatedUpdated {
    @PrimaryGeneratedColumn({ name: 'route_batch_id' })
    id: number;

    @Column({ name: 'driver_id', type: 'int', nullable: true })
    driverId: number | null;

    @Column({ name: 'vehicle_id', type: 'int', nullable: true })
    vehicleId: number | null;

    @Column({ name: 'status', type: 'varchar', length: 30 })
    status: string;

    // Incremented explicitly by planning operations.
    @Column({ name: 'version', type: 'int', default: 0 })
    version: number;

    @Column({ name: 'delivery_zone_id', type: 'int', nullable: true })
    deliveryZoneId: number | null;

    @Column({ name: 'origin_warehouse_id', type: 'int', nullable: true })
    originWarehouseId: number | null;

    @Column({ name: 'proposed_driver_id', type: 'int', nullable: true })
    proposedDriverId: number | null;

    @Column({ name: 'reviewer_user_id', type: 'int', nullable: true })
    reviewerUserId: number | null;

    @Column({ name: 'shift_date', type: 'date' })
    shiftDate: string;

    // Encoded polyline of the route calculated by OSRM, cached.
    @Column({ name: 'route_geometry', type: 'text', nullable: true })
    routeGeometry: string | null;

    @Column({ name: 'accepted_at', type: 'timestamptz', nullable: true })
    acceptedAt: Date | null;

    @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
    closedAt: Date | null;

    @ManyToOne(() => User)
    @JoinColumn({ name: 'driver_id' })
    driver: User | null;

    @ManyToOne(() => Vehicle)
    @JoinColumn({ name: 'vehicle_id' })
    vehicle: Vehicle | null;

    @ManyToOne(() => DeliveryZone)
    @JoinColumn({ name: 'delivery_zone_id' })
    deliveryZone: DeliveryZone | null;

    @ManyToOne(() => Warehouse)
    @JoinColumn({ name: 'origin_warehouse_id' })
    originWarehouse: Warehouse | null;

    @ManyToOne(() => User)
    @JoinColumn({ name: 'proposed_driver_id' })
    proposedDriver: User | null;

    @ManyToOne(() => User)
    @JoinColumn({ name: 'reviewer_user_id' })
    reviewerUser: User | null;
}
