import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntitySoftDelete } from '../../../../database/entities/base.entity.js';

// RF-A34 — catalog of vehicle incident types (e.g. "Mechanical failure"), managed by the fleet
// supervisor. `disablesVehicle` drives the automatic status-flip trigger of RF-A34, Escenario 2
// (see VehicleMaintenancesService.create()) — it is independent of `severity`, a separate
// classification used for reporting (see vehicle_incident_types/DICTIONARY.md).
@Entity('vehicle_incident_types')
export class VehicleIncidentType extends BaseEntitySoftDelete {
    @PrimaryGeneratedColumn({ name: 'vehicle_incident_type_id' })
    id: number;

    @Column({ name: 'code', type: 'varchar', length: 30 })
    code: string;

    @Column({ name: 'name', type: 'varchar', length: 100 })
    name: string;

    @Column({ name: 'severity', type: 'varchar', length: 20 })
    severity: string;

    @Column({ name: 'disables_vehicle', type: 'boolean', default: false })
    disablesVehicle: boolean;
}
