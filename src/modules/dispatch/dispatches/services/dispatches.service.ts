import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Dispatch } from '../entities/dispatch.entity.js';
import { DispatchNotFoundException } from '../exceptions/index.js';
import { MutationOptions } from '../../../../shared/dto/options.dto.js';

// Generic, direct operations only — no business logic. Orchestration (idempotency, ordering,
// transactions across modules) lives in app/sync, not here.
@Injectable()
export class DispatchesService {
    constructor(
        @InjectRepository(Dispatch)
        private readonly rawRepo: Repository<Dispatch>,
    ) {}

    async existsById(id: number, options?: MutationOptions): Promise<boolean> {
        const repo = options?.manager?.getRepository(Dispatch) ?? this.rawRepo;
        return repo.existsBy({ id });
    }

    /** Throws DispatchNotFoundException if the dispatch doesn't exist. */
    async updateStatus(id: number, dispatchStatusId: number, options?: MutationOptions): Promise<void> {
        const repo = options?.manager?.getRepository(Dispatch) ?? this.rawRepo;
        if (!(await this.existsById(id, options))) throw new DispatchNotFoundException();
        await repo.update(id, { dispatchStatusId });
    }
}
