import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BaseCreatedUpdated } from '../../../../database/entities/base.entity.js';
import { User } from '../../../auth/users/entities/user.entity.js';
import { Vehicle } from '../../../fleet/vehicles/entities/vehicle.entity.js';

@Entity('route_batches')
export class RouteBatch extends BaseCreatedUpdated {
    @PrimaryGeneratedColumn({ name: 'route_batch_id' })
    id: number;

    @Column({ name: 'driver_id', type: 'int', nullable: true })
    driverId: number | null;

    @Column({ name: 'vehicle_id', type: 'int', nullable: true })
    vehicleId: number | null;

    @Column({ name: 'shift_date', type: 'date' })
    shiftDate: string;

    // Encoded polyline of the route calculated by OSRM, cached.
    @Column({ name: 'route_geometry', type: 'text', nullable: true })
    routeGeometry: string | null;

    @ManyToOne(() => User)
    @JoinColumn({ name: 'driver_id' })
    driver: User | null;

    @ManyToOne(() => Vehicle)
    @JoinColumn({ name: 'vehicle_id' })
    vehicle: Vehicle | null;
}
