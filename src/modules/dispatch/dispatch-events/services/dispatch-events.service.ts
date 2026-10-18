import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DispatchEvent } from '../entities/dispatch-event.entity.js';
import { MutationOptions } from '../../../../shared/dto/options.dto.js';

export interface CreateDispatchEventData {
    dispatchId:      number;
    eventType:       string;
    detail?:         string | null;
    clientEventId?:  string | null;
    actorUserId?:    number | null;
    actorType?:      string | null;
    reason?:         string | null;
    metadata?:       Record<string, unknown> | null;
    /** When set, backdates createdAt to when the event actually happened on the device. */
    occurredAt?:     Date;
}

// Generic, direct operations only — no business logic. Orchestration (idempotency, ordering,
// transactions across modules) lives in app/sync, not here.
@Injectable()
export class DispatchEventsService {
    constructor(
        @InjectRepository(DispatchEvent)
        private readonly rawRepo: Repository<DispatchEvent>,
    ) {}

    async existsByClientEventId(clientEventId: string, options?: MutationOptions): Promise<boolean> {
        const repo = options?.manager?.getRepository(DispatchEvent) ?? this.rawRepo;
        return repo.existsBy({ clientEventId });
    }

    async findByClientEventId(clientEventId: string, options?: MutationOptions): Promise<Pick<DispatchEvent, 'dispatchId' | 'eventType' | 'createdAt' | 'metadata'> | null> {
        const repo = options?.manager?.getRepository(DispatchEvent) ?? this.rawRepo;
        return await repo.findOne({
            where: { clientEventId },
            select: { dispatchId: true, eventType: true, createdAt: true, metadata: true },
        });
    }

    async create(data: CreateDispatchEventData, options?: MutationOptions): Promise<DispatchEvent> {
        const repo = options?.manager?.getRepository(DispatchEvent) ?? this.rawRepo;
        const event = repo.create({
            dispatchId:     data.dispatchId,
            eventType:      data.eventType,
            detail:         data.detail ?? null,
            clientEventId:  data.clientEventId ?? null,
            actorUserId:    data.actorUserId ?? null,
            actorType:      data.actorType ?? null,
            reason:         data.reason ?? null,
            metadata:       data.metadata ?? null,
            ...(data.occurredAt && { createdAt: data.occurredAt }),
        });
        return repo.save(event);
    }
}
