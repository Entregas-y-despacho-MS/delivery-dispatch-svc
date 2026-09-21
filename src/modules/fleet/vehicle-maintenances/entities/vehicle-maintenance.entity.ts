import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BaseCreatedUpdated } from '../../../../database/entities/base.entity.js';
import { Vehicle } from '../../vehicles/entities/vehicle.entity.js';
import { VehicleIncidentType } from '../../vehicle-incident-types/entities/vehicle-incident-type.entity.js';

@Entity('vehicle_maintenances')
export class VehicleMaintenance extends BaseCreatedUpdated {
    @PrimaryGeneratedColumn({ name: 'vehicle_maintenance_id' })
    id: number;

    @Column({ name: 'vehicle_id', type: 'int' })
    vehicleId: number;

    @Column({ name: 'vehicle_incident_type_id', type: 'int', nullable: true })
    vehicleIncidentTypeId: number | null;

    @Column({ name: 'description', type: 'text' })
    description: string;

    // pending | in_progress | completed
    @Column({ name: 'status', type: 'varchar', length: 20, default: 'pending' })
    status: string;

    @Column({ name: 'scheduled_at', type: 'timestamptz', nullable: true })
    scheduledAt: Date | null;

    @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
    completedAt: Date | null;

    @ManyToOne(() => Vehicle)
    @JoinColumn({ name: 'vehicle_id' })
    vehicle: Vehicle;

    @ManyToOne(() => VehicleIncidentType)
    @JoinColumn({ name: 'vehicle_incident_type_id' })
    vehicleIncidentType: VehicleIncidentType | null;
}
