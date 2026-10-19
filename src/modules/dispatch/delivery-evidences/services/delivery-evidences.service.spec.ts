import { describe, expect, it, vi } from 'vitest';
import type { Repository } from 'typeorm';
import { DeliveryEvidence } from '../entities/delivery-evidence.entity.js';
import { DeliveryEvidencesService, type CreateDeliveryEvidenceData } from './delivery-evidences.service.js';

describe('DeliveryEvidencesService', () => {
    it('always persists otpCode as null, even if an untyped caller supplies one', async () => {
        const evidence = { id: 'evidence-1' } as DeliveryEvidence;
        const repo = {
            create: vi.fn((value: Partial<DeliveryEvidence>) => value as DeliveryEvidence),
            insert: vi.fn(),
            findOneByOrFail: vi.fn().mockResolvedValue(evidence),
        };
        const service = new DeliveryEvidencesService(repo as unknown as Repository<DeliveryEvidence>);
        const data = {
            id: 'evidence-1', dispatchId: 12, type: 'signature', otpCode: '123456',
        } as CreateDeliveryEvidenceData;

        await service.create(data);

        expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ otpCode: null }));
        expect(repo.create.mock.calls[0][0]).not.toHaveProperty('otpCode', '123456');
    });
});
