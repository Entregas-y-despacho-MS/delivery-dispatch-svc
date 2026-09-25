import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Dispatch } from '../entities/dispatch.entity.js';
import { DispatchNotFoundException } from '../exceptions/index.js';
import { MutationOptions } from '../../../../shared/dto/options.dto.js';
import { DispatchStatusEnum } from '../../../../shared/enums/index.js';

// A dispatch is "active" (in progress) until it reaches a final state. `not_delivered` is left out on
// purpose: it is a failed attempt that can still be rescheduled, but the business definition used for
// RF-A31 is "en proceso de entrega" = pending or in transit. Change it here if that ever widens.
const ACTIVE_STATUSES = [DispatchStatusEnum.PENDING, DispatchStatusEnum.IN_TRANSIT];

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

    /** Whether any dispatch that is still in progress uses this service level (RF-A31, Escenario 3). */
    async hasActiveByServiceLevel(serviceLevelId: number, options?: MutationOptions): Promise<boolean> {
        const repo = options?.manager?.getRepository(Dispatch) ?? this.rawRepo;
        return repo.exists({ where: { serviceLevelId, dispatchStatus: { name: In(ACTIVE_STATUSES) } } });
    }

    /** Throws DispatchNotFoundException if the dispatch doesn't exist. */
    async updateStatus(id: number, dispatchStatusId: number, options?: MutationOptions): Promise<void> {
        const repo = options?.manager?.getRepository(Dispatch) ?? this.rawRepo;
        if (!(await this.existsById(id, options))) throw new DispatchNotFoundException();
        await repo.update(id, { dispatchStatusId });
    }
}
