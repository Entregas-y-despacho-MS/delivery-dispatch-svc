import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { BaseCreatedUpdated } from '../../../../database/entities/base.entity.js';
import { User } from '../../users/entities/user.entity.js';

// Structural catalog — exactly 5 rows (root/admin/coordinator/supervisor/driver), seeded by
// schema/auth/roles/data.sql, not administrable via the API. No soft delete: these rows are
// never deleted. See RoleEnum (shared/enums/role.enum.ts) — values must match `name` exactly.
@Entity('roles')
export class Role extends BaseCreatedUpdated {
    @PrimaryGeneratedColumn({ name: 'role_id' })
    id: number;

    @Column({ name: 'name', type: 'varchar', length: 30, unique: true })
    name: string;

    // Inverse side of the relation — not loaded unless explicitly requested.
    @OneToMany(() => User, (user) => user.role)
    users: User[];
}
