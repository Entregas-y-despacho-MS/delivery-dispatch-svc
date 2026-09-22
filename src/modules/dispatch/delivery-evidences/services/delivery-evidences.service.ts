import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DeliveryEvidence } from '../entities/delivery-evidence.entity.js';
import { MutationOptions } from '../../../../shared/dto/options.dto.js';

export interface CreateDeliveryEvidenceData {
    /** Client-generated UUID v7 — the record's own PK, and its idempotency key. */
    id:          string;
    dispatchId:  number;
    type:        string;
    fileUrl?:    string | null;
    otpCode?:    string | null;
    /** When set, backdates createdAt to when the evidence was actually captured on the device. */
    occurredAt?: Date;
}

// Generic, direct operations only — no business logic. Orchestration (idempotency, uploading the
// file via StoragePort) lives in app/sync, not here.
@Injectable()
export class DeliveryEvidencesService {
    constructor(
        @InjectRepository(DeliveryEvidence)
        private readonly rawRepo: Repository<DeliveryEvidence>,
    ) {}

    async existsById(id: string, options?: MutationOptions): Promise<boolean> {
        const repo = options?.manager?.getRepository(DeliveryEvidence) ?? this.rawRepo;
        return repo.existsBy({ id });
    }

    async create(data: CreateDeliveryEvidenceData, options?: MutationOptions): Promise<DeliveryEvidence> {
        const repo = options?.manager?.getRepository(DeliveryEvidence) ?? this.rawRepo;
        const evidence = repo.create({
            id:          data.id,
            dispatchId:  data.dispatchId,
            type:        data.type,
            fileUrl:     data.fileUrl ?? null,
            otpCode:     data.otpCode ?? null,
            ...(data.occurredAt && { createdAt: data.occurredAt }),
        });
        return repo.save(evidence);
    }
}
