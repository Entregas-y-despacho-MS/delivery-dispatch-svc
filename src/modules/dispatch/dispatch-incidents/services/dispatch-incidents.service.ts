import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DispatchIncident } from '../entities/dispatch-incident.entity.js';
import { MutationOptions } from '../../../../shared/dto/options.dto.js';

export interface CreateDispatchIncidentData {
    /** Client-generated UUID v7 — the record's own PK, and its idempotency key. */
    id:               string;
    dispatchId:       number;
    incidentReasonId: number;
    description?:     string | null;
    /** When set, backdates createdAt to when the incident actually happened on the device. */
    occurredAt?:      Date;
}

// Generic, direct operations only — no business logic. Orchestration (idempotency, ordering,
// transactions across modules) lives in app/sync, not here.
@Injectable()
export class DispatchIncidentsService {
    constructor(
        @InjectRepository(DispatchIncident)
        private readonly rawRepo: Repository<DispatchIncident>,
    ) {}

    async existsById(id: string, options?: MutationOptions): Promise<boolean> {
        const repo = options?.manager?.getRepository(DispatchIncident) ?? this.rawRepo;
        return repo.existsBy({ id });
    }

    async create(data: CreateDispatchIncidentData, options?: MutationOptions): Promise<DispatchIncident> {
        const repo = options?.manager?.getRepository(DispatchIncident) ?? this.rawRepo;
        const incident = repo.create({
            id:               data.id,
            dispatchId:       data.dispatchId,
            incidentReasonId: data.incidentReasonId,
            description:      data.description ?? null,
            ...(data.occurredAt && { createdAt: data.occurredAt }),
        });
        return repo.save(incident);
    }
}
