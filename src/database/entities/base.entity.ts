import { CreateDateColumn, UpdateDateColumn, DeleteDateColumn } from 'typeorm';

/**
 * Progressive base classes for TypeORM entities. Choose the one that fits:
 *
 *   BaseCreated          → createdAt only
 *   BaseCreatedUpdated   → createdAt + updatedAt
 *   BaseEntitySoftDelete → createdAt + updatedAt + deletedAt (soft delete)
 */

export abstract class BaseCreated {
    @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
    createdAt: Date;
}

export abstract class BaseCreatedUpdated extends BaseCreated {
    @UpdateDateColumn({ name: 'updated_at', type: 'timestamp' })
    updatedAt: Date;
}

/**
 * Soft delete via @DeleteDateColumn.
 * TypeORM automatically appends WHERE deleted_at IS NULL to all finds.
 * Use repo.softDelete(id) / repo.restore(id) / repo.find({ withDeleted: true }).
 */
export abstract class BaseEntitySoftDelete extends BaseCreatedUpdated {
    @DeleteDateColumn({ name: 'deleted_at', type: 'timestamp', nullable: true })
    deletedAt: Date | null;
}
