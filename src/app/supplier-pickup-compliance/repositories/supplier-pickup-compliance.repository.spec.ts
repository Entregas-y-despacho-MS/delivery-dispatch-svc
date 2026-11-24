import { describe, expect, it, vi } from 'vitest';
import { SUPPLIER_PICKUP_ROWS_SQL, SupplierPickupComplianceRepository } from './supplier-pickup-compliance.repository.js';
import type { DataSource } from 'typeorm';

// The SQL itself is exercised against a real Postgres by test/supplier-pickup-compliance.e2e-spec.ts; here only the contract
// with the driver: parameter order, NULL for a missing filter and the mapping of the columns.
describe('SupplierPickupComplianceRepository', () => {
    const raw = {
        dispatch_id: 7, status: 'incident', source_order_ref: 'PO-7', supplier_id: 'SUP-1', supplier_name: 'Acme', destination_warehouse_id: 2,
        window_start: new Date('2026-11-18T14:00:00Z'), window_end: new Date('2026-11-18T16:00:00Z'),
        original_window_start: null, original_window_end: null, first_reschedule_at: null, custody_received_at: null, arrived_at_warehouse_at: null,
    };

    it('passes the filters in order with NULL for the missing ones', async () => {
        const query = vi.fn().mockResolvedValue([]);
        const repository = new SupplierPickupComplianceRepository({ query } as unknown as DataSource);
        await repository.findAppointments({ from: '2026-11-01', to: '2026-11-30' });
        expect(query).toHaveBeenCalledWith(SUPPLIER_PICKUP_ROWS_SQL, ['2026-11-01', '2026-11-30', null, null, null, null]);
        await repository.findAppointments({ from: '2026-11-01', to: '2026-11-30', supplierId: 'S', warehouseId: 2, zoneId: 3, status: 'incident' });
        expect(query).toHaveBeenLastCalledWith(SUPPLIER_PICKUP_ROWS_SQL, ['2026-11-01', '2026-11-30', 'S', 2, 3, 'incident']);
    });

    it('maps the columns to the facts of the pickup', async () => {
        const repository = new SupplierPickupComplianceRepository({ query: vi.fn().mockResolvedValue([raw]) } as unknown as DataSource);
        const [row] = await repository.findAppointments({ from: '2026-11-01', to: '2026-11-30' });
        expect(row).toMatchObject({ dispatchId: 7, status: 'incident', purchaseOrderRef: 'PO-7', supplierId: 'SUP-1', supplierName: 'Acme', destinationWarehouseId: 2, windowEnd: raw.window_end, custodyReceivedAt: null });
    });
});
