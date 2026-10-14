import { describe, expect, it, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import { ProcurementPickupRepository } from './procurement-pickup.repository.js';

const request = {
  purchaseOrderId: 'PO-1',
  recordVersion: 1,
  updatedAt: '2026-10-12T14:00:00Z',
  supplier: { supplierId: 'SUP-1', name: 'Proveedor Uno' },
  warehouseId: 'WH-MISSING',
  products: [{ productId: 'SKU-1', quantity: 3 }],
};

describe('ProcurementPickupRepository', () => {
  it('creates a plannable supplier pickup and persists expected products', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([]) // existing dispatch
      .mockResolvedValueOnce([{ warehouse_id: 9 }]) // destination warehouse lookup
      .mockResolvedValueOnce([{ dispatch_id: 42 }]) // dispatch insert
      .mockResolvedValue([]);
    const repository = new ProcurementPickupRepository();
    const completeRequest = {
      ...request,
      warehouseId: 'WH-LPZ-01',
      transportConditions: ['fragilidad', 'temperatura controlada'],
      pickupAddress: { line: 'Av. Panamericana km 3' },
      pickupWindow: {
        startsAt: '2026-10-13T13:00:00Z',
        endsAt: '2026-10-13T18:00:00Z',
      },
    };

    await repository.applyRequested(completeRequest, {
      manager: { query } as unknown as EntityManager,
    });

    const insertDispatch = query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO dispatches'),
    );
    expect(insertDispatch?.[1]).toEqual(
      expect.arrayContaining([
        'pending',
        'PO-1',
        'Av. Panamericana km 3',
        9,
        JSON.stringify(['fragilidad', 'temperatura controlada']),
      ]),
    );
    expect(
      query.mock.calls.some(
        ([sql, values]) =>
          String(sql).includes('INSERT INTO dispatch_pickup_items') &&
          (values as unknown[]).includes('SKU-1'),
      ),
    ).toBe(true);
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes('dispatch_address_review_required'),
      ),
    ).toBe(false);
  });

  it('creates address_review when the address, schedule or destination warehouse needs correction', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([]) // existing dispatch
      .mockResolvedValueOnce([]) // destination warehouse lookup
      .mockResolvedValueOnce([{ dispatch_id: 42 }]) // dispatch insert
      .mockResolvedValue([]);
    const repository = new ProcurementPickupRepository();

    await repository.applyRequested(request, {
      manager: { query } as unknown as EntityManager,
    });

    const insertDispatch = query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO dispatches'),
    );
    expect(insertDispatch?.[1]).toEqual(
      expect.arrayContaining([
        'address_review',
        'PO-1',
        'Pendiente de corrección',
      ]),
    );
    const event = query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO dispatch_events'),
    );
    expect(JSON.parse(String(event?.[1]?.[2]))).toMatchObject({
      purchaseOrderId: 'PO-1',
      missingFields: ['pickupAddress', 'pickupWindow', 'warehouseId'],
    });
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes('dispatch_address_review_required'),
      ),
    ).toBe(true);
  });

  it('records a coordinator alert and leaves completed dispatches unchanged', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([
        {
          dispatch_id: 42,
          status: 'in_transit',
          delivery_address: 'Av. 1',
          scheduled_window_start: null,
          scheduled_window_end: null,
          destination_warehouse_id: null,
        },
      ])
      .mockResolvedValue([]);
    const repository = new ProcurementPickupRepository();

    await repository.applyCancelled(
      {
        purchaseOrderId: 'PO-1',
        recordVersion: 3,
        updatedAt: '2026-10-12T16:00:00Z',
        cancelledAt: '2026-10-12T15:59:00Z',
      },
      { manager: { query } as unknown as EntityManager },
    );

        expect(
          query.mock.calls.some(([, values]) =>
            (values as unknown[])?.includes(
              'supplier_pickup_cancel_requires_coordinator',
            ),
          ),
        ).toBe(true);
        expect(
          query.mock.calls.some(([sql, values]) =>
            String(sql).includes('INSERT INTO dispatch_events') &&
            (values as unknown[])?.includes('change_requires_attention'),
          ),
        ).toBe(true);
        expect(
          query.mock.calls.some(([sql]) =>
            String(sql).includes('UPDATE dispatches'),
      ),
    ).toBe(false);
  });
});
