import { describe, expect, it, vi } from 'vitest';
import { SupplierPickupComplianceService } from './supplier-pickup-compliance.service.js';
import type { SupplierPickupComplianceRepository } from '../repositories/supplier-pickup-compliance.repository.js';

const NOW = new Date('2026-11-20T12:00:00Z');

function build(rows: unknown[] = []) {
    const repository = { findAppointments: vi.fn().mockResolvedValue(rows) };
    return { repository, service: new SupplierPickupComplianceService(repository as unknown as SupplierPickupComplianceRepository) };
}

describe('SupplierPickupComplianceService', () => {
    it('asks the repository for the filters and builds the report at the cut', async () => {
        const { repository, service } = build();
        const query = { from: '2026-11-01', to: '2026-11-30', supplierId: 'SUP-1' };
        const report = await service.getCompliance(query, 10, NOW);
        expect(repository.findAppointments).toHaveBeenCalledWith(query);
        expect(report).toMatchObject({ asOf: NOW.toISOString(), empty: true, filters: { supplierId: 'SUP-1' } });
    });

    it('rejects an inverted range before touching the database', async () => {
        const { repository, service } = build();
        await expect(service.getCompliance({ from: '2026-11-30', to: '2026-11-01' }, 10, NOW)).rejects.toThrow();
        expect(repository.findAppointments).not.toHaveBeenCalled();
    });

    it('rejects a range longer than a year', async () => {
        const { repository, service } = build();
        await expect(service.getCompliance({ from: '2025-01-01', to: '2026-11-30' }, 10, NOW)).rejects.toThrow();
        expect(repository.findAppointments).not.toHaveBeenCalled();
    });
});
