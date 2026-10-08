import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntitySoftDelete } from '../../../../database/entities/base.entity.js';
import { numericTransformer } from '../../../../shared/orm/index.js';

// Corrección de ES-26/ST-26.1 — catálogo mínimo de solo lectura (sembrado directo, sin endpoints
// de alta/edición). El origen de rutas para OSRM y el horario de recepción (ST-50.2/ST-75.1 de
// Sprint 2) leen esta tabla; este módulo solo expone listar y obtener por ID.
@Entity('warehouses')
export class Warehouse extends BaseEntitySoftDelete {
    @PrimaryGeneratedColumn({ name: 'warehouse_id' })
    id: number;

    @Column({ name: 'code', type: 'varchar', length: 30 })
    code: string;

    @Column({ name: 'name', type: 'varchar', length: 100 })
    name: string;

    @Column({ name: 'address', type: 'text' })
    address: string;

    @Column({ name: 'latitude', type: 'numeric', precision: 9, scale: 6, transformer: numericTransformer })
    latitude: number;

    @Column({ name: 'longitude', type: 'numeric', precision: 9, scale: 6, transformer: numericTransformer })
    longitude: number;

    @Column({ name: 'contact_name', type: 'varchar', length: 150, nullable: true })
    contactName: string | null;

    @Column({ name: 'contact_phone', type: 'varchar', length: 30, nullable: true })
    contactPhone: string | null;

    // 'HH:mm:ss', as the pg driver returns a TIME column — there is no date component to parse.
    @Column({ name: 'reception_start_time', type: 'time' })
    receptionStartTime: string;

    @Column({ name: 'reception_end_time', type: 'time' })
    receptionEndTime: string;

    @Column({ name: 'active', type: 'boolean', default: true })
    active: boolean;
}
