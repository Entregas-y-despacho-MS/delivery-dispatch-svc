import { EntityManager } from 'typeorm';

export interface FindOptions {
    /** When false, returns null instead of throwing NotFoundException. Default: true. */
    throwException?: boolean;
}

export interface MutationOptions {
    /** Pass an EntityManager to participate in an existing transaction. */
    manager?: EntityManager;
    /** When true, permanently deletes the record. Default: false (soft delete). */
    hardDelete?: boolean;
}
