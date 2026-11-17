import { ConflictException, ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { DispatchIncidentsAppService } from './dispatch-incidents.service.js';

const dto = {
    incidentId: '01933b6e-7f2a-7c3d-9a1b-2f8e6c4d5a10',
    reasonCode: 'INC-CUST-ABSENT',
    observations: 'The customer was not available at the address.',
    occurredAt: new Date(Date.now() - 60_000).toISOString(),
    lat: -16.5,
    lng: -68.1,
    evidenceId: '01933b6e-7f2a-7c3d-9a1b-2f8e6c4d5a11',
};

function setup(options: { existing?: unknown; reason?: unknown; evidence?: unknown; status?: string; driverId?: number } = {}) {
    const queries: string[] = [];
    let committed = false;
    const manager = {
        query: vi.fn(async (sql: string) => {
            queries.push(sql);
            if (sql.includes('SELECT route_batch_id FROM dispatches')) return [{ route_batch_id: 7 }];
            if (sql.includes('FROM route_batches WHERE')) return [{ route_batch_id: 7, driver_id: options.driverId ?? 42 }];
            if (sql.includes('JOIN dispatch_statuses')) return [{ dispatch_id: 10, route_batch_id: 7, delivery_zone_id: 3, status: options.status ?? 'in_transit' }];
            if (sql.includes('FROM dispatch_incidents i')) return options.existing ? [options.existing] : [];
            if (sql.includes('FROM incident_reasons')) return [options.reason ?? {
                incident_reason_id: 2, code: 'INC-CUST-ABSENT', name: 'Customer absent', active: true,
                requires_evidence: true, counts_as_attempt: true, criticality: 'high',
            }];
            if (sql.includes('FROM dispatch_statuses')) return [{ dispatch_status_id: 11 }];
            return [];
        }),
    };
    const dataSource = {
        transaction: vi.fn(async (work: (tx: typeof manager) => Promise<unknown>) => {
            const result = await work(manager);
            committed = true;
            return result;
        }),
    };
    const incidents = { create: vi.fn(async () => ({})) };
    const evidences = { findById: vi.fn(async () => ('evidence' in options ? options.evidence : { id: dto.evidenceId, dispatchId: 10, type: 'photo', fileUrl: 'https://files.test/photo.jpg' })) };
    const dispatchEvents = { create: vi.fn(async () => ({})) };
    const events = { emit: vi.fn(() => { expect(committed).toBe(true); }) };
    const service = new DispatchIncidentsAppService(dataSource as never, incidents as never, evidences as never, dispatchEvents as never, events as never);
    return { service, manager, incidents, evidences, dispatchEvents, events, dataSource, queries };
}

describe('DispatchIncidentsAppService', () => {
    it('commits incident, status and event together, then emits one high-criticality alert', async () => {
        const ctx = setup();

        const result = await ctx.service.report(10, 42, dto);

        expect(result.created).toBe(true);
        expect(result.incident).toMatchObject({ dispatchId: 10, incidentId: dto.incidentId, reasonCode: dto.reasonCode, status: 'incident' });
        expect(ctx.incidents.create).toHaveBeenCalledWith(expect.objectContaining({ id: dto.incidentId, dispatchId: 10, incidentReasonId: 2 }), { manager: expect.any(Object) });
        expect(ctx.dispatchEvents.create).toHaveBeenCalledWith(expect.objectContaining({
            dispatchId: 10, eventType: 'status_changed', clientEventId: dto.incidentId,
            metadata: expect.objectContaining({ previousStatus: 'in_transit', status: 'incident', occurredAt: dto.occurredAt, lat: dto.lat, lng: dto.lng, evidenceId: dto.evidenceId }),
        }), { manager: expect.any(Object) });
        expect(ctx.queries.some((sql) => sql.includes('UPDATE dispatches'))).toBe(true);
        expect(ctx.events.emit).toHaveBeenCalledWith('dispatch.incident_reported', expect.objectContaining({
            dispatchId: 10, incidentId: dto.incidentId, reasonCode: dto.reasonCode, criticality: 'high',
        }));
    });

    it('returns an existing report without duplicating writes or emitting again', async () => {
        const ctx = setup({ existing: { dispatch_id: 10, reason_code: dto.reasonCode, description: dto.observations, created_at: new Date(dto.occurredAt), metadata: { lat: dto.lat, lng: dto.lng, evidenceId: dto.evidenceId, reportedAt: '2026-10-19T11:05:00.000Z' } } });

        const result = await ctx.service.report(10, 42, dto);

        expect(result.created).toBe(false);
        expect(result.incident.reportedAt).toBe('2026-10-19T11:05:00.000Z');
        expect(ctx.incidents.create).not.toHaveBeenCalled();
        expect(ctx.dispatchEvents.create).not.toHaveBeenCalled();
        expect(ctx.events.emit).not.toHaveBeenCalled();
    });

    it('rejects reuse of an incidentId across dispatches or with a different body', async () => {
        const ctx = setup({ existing: { dispatch_id: 99, reason_code: dto.reasonCode, created_at: new Date(), metadata: null } });
        await expect(ctx.service.report(10, 42, dto)).rejects.toBeInstanceOf(ConflictException);
        const differentBody = setup({ existing: { dispatch_id: 10, reason_code: dto.reasonCode, description: 'Different observations', created_at: new Date(dto.occurredAt), metadata: { lat: dto.lat, lng: dto.lng, evidenceId: dto.evidenceId } } });
        await expect(differentBody.service.report(10, 42, dto)).rejects.toBeInstanceOf(ConflictException);
    });

    it('hides a dispatch assigned to another driver behind forbidden access', async () => {
        const ctx = setup({ driverId: 999 });
        await expect(ctx.service.report(10, 42, dto)).rejects.toBeInstanceOf(ForbiddenException);
        expect(ctx.incidents.create).not.toHaveBeenCalled();
    });

    it('rejects missing dispatch and inactive reason before writes', async () => {
        const missing = setup();
        missing.manager.query.mockImplementation(async (sql: string) => sql.includes('SELECT route_batch_id FROM dispatches') ? [] : []);
        await expect(missing.service.report(10, 42, dto)).rejects.toBeInstanceOf(NotFoundException);

        const inactive = setup({ reason: null });
        inactive.manager.query.mockImplementation(async (sql: string) => {
            if (sql.includes('SELECT route_batch_id FROM dispatches')) return [{ route_batch_id: 7 }];
            if (sql.includes('FROM route_batches WHERE')) return [{ route_batch_id: 7, driver_id: 42 }];
            if (sql.includes('JOIN dispatch_statuses')) return [{ dispatch_id: 10, route_batch_id: 7, delivery_zone_id: 3, status: 'in_transit' }];
            if (sql.includes('FROM dispatch_incidents i')) return [];
            if (sql.includes('FROM incident_reasons')) return [];
            return [];
        });
        await expect(inactive.service.report(10, 42, dto)).rejects.toBeInstanceOf(NotFoundException);
        expect(inactive.incidents.create).not.toHaveBeenCalled();
    });

    it('requires a photo belonging to this dispatch when the catalog requires evidence', async () => {
        const ctx = setup({ evidence: null });
        await expect(ctx.service.report(10, 42, dto)).rejects.toBeInstanceOf(UnprocessableEntityException);
        expect(ctx.incidents.create).not.toHaveBeenCalled();
    });

    it('allows company failure without evidence and does not modify promise fields', async () => {
        const ctx = setup({
            reason: { incident_reason_id: 8, code: 'INC-COMP-FAILURE', name: 'Company or vehicle failure', active: true, requires_evidence: false, counts_as_attempt: false },
        });
        const { evidenceId: _ignored, ...withoutEvidence } = dto;

        await ctx.service.report(10, 42, withoutEvidence);

        expect(ctx.evidences.findById).not.toHaveBeenCalled();
        const dispatchUpdate = ctx.queries.find((sql) => sql.includes('UPDATE dispatches'))!;
        expect(dispatchUpdate).not.toMatch(/promise|attempt/i);
    });

    it('rejects a report unless the dispatch is in transit', async () => {
        const ctx = setup({ status: 'out_for_delivery' });
        await expect(ctx.service.report(10, 42, dto)).rejects.toBeInstanceOf(ConflictException);
        expect(ctx.incidents.create).not.toHaveBeenCalled();
    });
});
