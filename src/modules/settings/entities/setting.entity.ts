import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

// PK is the natural key (setting_key), not a SERIAL id — configuration table, not an entity with
// its own identity. No createdAt/deletedAt in the real schema, so this doesn't extend BaseEntity*.
@Entity('settings')
export class Setting {
    @PrimaryColumn({ name: 'setting_key', type: 'varchar', length: 100 })
    key: string;

    @Column({ name: 'setting_value', type: 'text' })
    value: string;

    @Column({ name: 'description', type: 'text', nullable: true })
    description: string | null;

    @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
    updatedAt: Date;
}
