import { ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DispatchEventsService } from '../../../modules/dispatch/dispatch-events/services/dispatch-events.service.js';
import { DeliveryEvidencesService } from '../../../modules/dispatch/delivery-evidences/services/delivery-evidences.service.js';
import { DispatchNotFoundException } from '../../../modules/dispatch/dispatches/exceptions/dispatch-not-found.exception.js';
import { DispatchStatusEnum } from '../../../shared/enums/dispatch-status.enum.js';
import { DISPATCH_STATUS_CHANGED_EVENT } from '../dispatch-status-changed.event.js';
import { DispatchStatusConflictException } from '../exceptions/dispatch-status-conflict.exception.js';
import { UpdateDispatchStatusDto } from '../dto/update-dispatch-status.dto.js';
import { DispatchStatusService } from './dispatch-status.service.js';
import { DispatchStatusPublicationService } from '../../../modules/dispatch/dispatch-status-publication/dispatch-status-publication.service.js';

const eventId = '01933b6e-7f2a-7c3d-9a1b-2f8e6c4d5a10';
const dto = (status: UpdateDispatchStatusDto['status']): UpdateDispatchStatusDto => ({
    status, eventId, occurredAt: new Date().toISOString(), lat: -16.5, lng: -68.1, accuracy: 8.4,
});

function setup(options: {
    current?: string;
    driverId?: number;
    batchStatus?: string;
    identity?: { route_batch_id: number | null }[];
    batch?: { id: number; driver_id: number | null; status: string }[];
    latest?: { created_at: Date }[];
    active?: { dispatch_id: number }[];
    target?: { dispatch_status_id: number }[];
    updated?: { updated_at: Date }[];
    remaining?: { dispatch_id: number }[];
    closed?: { closed_at: Date }[];
    previous?: { dispatchId: number; eventType: string; createdAt: Date; metadata: Record<string, unknown> } | null;
    evidence?: boolean;
} = {}) {
    const saved = new Date();
    const state = {
        identity: options.identity ?? [{ route_batch_id: 55 }],
        batch: options.batch ?? [{ id: 55, driver_id: options.driverId ?? 7, status: options.batchStatus ?? 'in_execution' }],
        dispatch: [{ id: 12, route_batch_id: 55, status: options.current ?? DispatchStatusEnum.OUT_FOR_DELIVERY, evidence_policy: 'hand_delivery_standard', version: 4, updated_at: saved }],
        latest: options.latest ?? [], active: options.active ?? [], target: options.target ?? [{ dispatch_status_id: 3 }], updated: options.updated ?? [{ updated_at: saved }],
        remaining: options.remaining ?? [{ dispatch_id: 12 }], closed: options.closed ?? [{ closed_at: saved }],
    };
    const queryResults = [
        {
            name: 'dispatch identity',
            matches: (sql: string) => sql.startsWith('SELECT route_batch_id FROM dispatches'),
            rows: state.identity,
        },
        {
            name: 'active route dispatch',
            matches: (sql: string) => sql.startsWith('SELECT d.dispatch_id FROM dispatches') && sql.includes('ds.name = $3'),
            rows: state.active,
        },
        {
            name: 'open route dispatch',
            matches: (sql: string) => sql.startsWith('SELECT d.dispatch_id FROM dispatches') && sql.includes('ds.name = ANY'),
            rows: state.remaining,
        },
        {
            name: 'route batch lock',
            matches: (sql: string) => sql.startsWith('SELECT route_batch_id AS id, driver_id, status FROM route_batches'),
            rows: state.batch,
        },
        {
            name: 'dispatch state',
            matches: (sql: string) => sql.startsWith('SELECT d.dispatch_id AS id, d.route_batch_id'),
            rows: state.dispatch,
        },
        {
            name: 'latest status event',
            matches: (sql: string) => sql.includes("event_type = 'status_changed'"),
            rows: state.latest,
        },
        {
            name: 'target status',
            matches: (sql: string) => sql.startsWith('SELECT dispatch_status_id FROM dispatch_statuses'),
            rows: state.target,
        },
        {
            name: 'dispatch update',
            matches: (sql: string) => sql.startsWith('WITH updated AS') && sql.includes('UPDATE dispatches'),
            rows: state.updated,
        },
        {
            name: 'route batch close',
            matches: (sql: string) => sql.startsWith('UPDATE route_batches'),
            rows: state.closed,
        },
        {
            name: 'closed route event',
            matches: (sql: string) => sql.startsWith('INSERT INTO route_batch_events'),
            rows: [],
        },
    ];
    const manager = { query: vi.fn(async (sql: string) => {
        const normalizedSql = sql.replace(/\s+/g, ' ').trim();
        const matches = queryResults.filter((query) => query.matches(normalizedSql));
        if (matches.length !== 1) {
            throw new Error(`Expected one SQL fixture match, found ${matches.length}: ${normalizedSql}`);
        }
        return matches[0].rows;
    }) };
    const dataSource = { transaction: vi.fn(async (work: (manager: unknown) => unknown) => work(manager)) };
    const dispatchEvents = {
        findByClientEventId: vi.fn().mockResolvedValue(options.previous ?? null),
        create: vi.fn().mockResolvedValue(undefined),
    };
    const deliveryEvidences = { existsByDispatchAndType: vi.fn().mockResolvedValue(options.evidence ?? true) };
    const statusPublication = { publish: vi.fn().mockResolvedValue(1) };
    const events = { emit: vi.fn() };
    const service = new DispatchStatusService(
        dataSource as never,
        dispatchEvents as unknown as DispatchEventsService,
        deliveryEvidences as unknown as DeliveryEvidencesService,
        events as unknown as EventEmitter2,
        statusPublication as unknown as DispatchStatusPublicationService,
    );
    return { service, manager, dataSource, dispatchEvents, deliveryEvidences, events, statusPublication, saved };
}

describe('DispatchStatusService.update', () => {
    beforeEach(() => vi.clearAllMocks());

    it('transitions to in_transit, logs actor/event/GPS and emits only after transaction', async () => {
        const ctx = setup();
        ctx.dataSource.transaction.mockImplementationOnce(async (work: (manager: unknown) => unknown) => {
            const result = await work(ctx.manager);
            expect(ctx.events.emit).not.toHaveBeenCalled();
            return result;
        });

        const result = await ctx.service.update(12, dto(DispatchStatusEnum.IN_TRANSIT), 7);

        expect(result).toMatchObject({ dispatchId: 12, status: 'in_transit', previousStatus: 'out_for_delivery', version: 4 });
        expect(ctx.dispatchEvents.create).toHaveBeenCalledWith(expect.objectContaining({
            clientEventId: eventId, actorUserId: 7, actorType: 'user', occurredAt: expect.any(Date),
            metadata: expect.objectContaining({ previousStatus: 'out_for_delivery', status: 'in_transit', version: 4, lat: -16.5, lng: -68.1, accuracy: 8.4 }),
        }), { manager: ctx.manager });
        expect(ctx.statusPublication.publish).not.toHaveBeenCalled();
        const updateSql = ctx.manager.query.mock.calls.find(([sql]) => sql.includes('UPDATE dispatches'))?.[0] ?? '';
        expect(updateSql).toContain('SET dispatch_status_id = $1, updated_at = now()');
        expect(updateSql).not.toMatch(/version|latitude|longitude|gps/i);
        expect(ctx.events.emit).toHaveBeenCalledWith(DISPATCH_STATUS_CHANGED_EVENT, expect.objectContaining({ status: 'in_transit', previousStatus: 'out_for_delivery' }));
    });

    it('closes the batch and records a system event in the same transaction when no open dispatch remains', async () => {
        const ctx = setup({
            current: DispatchStatusEnum.IN_TRANSIT,
            remaining: [],
        });
        ctx.dataSource.transaction.mockImplementationOnce(async (work: (manager: unknown) => unknown) => {
            const result = await work(ctx.manager);
            expect(ctx.events.emit).not.toHaveBeenCalled();
            return result;
        });

        await ctx.service.update(12, dto(DispatchStatusEnum.DELIVERED), 7);

        const closeIndex = ctx.manager.query.mock.calls.findIndex(([sql]) => String(sql).includes('UPDATE route_batches'));
        const routeEventIndex = ctx.manager.query.mock.calls.findIndex(([sql]) => String(sql).includes("INSERT INTO route_batch_events"));
        expect(closeIndex).toBeGreaterThan(-1);
        expect(routeEventIndex).toBeGreaterThan(closeIndex);
        expect(ctx.manager.query.mock.calls[routeEventIndex]).toMatchObject([
            expect.stringContaining("'closed', NULL, 'system'"),
            [55, 'All route dispatches are outside active states.', JSON.stringify({ dispatchId: 12, dispatchStatus: DispatchStatusEnum.DELIVERED })],
        ]);
        expect(ctx.events.emit).toHaveBeenCalledWith(DISPATCH_STATUS_CHANGED_EVENT, expect.objectContaining({ status: DispatchStatusEnum.DELIVERED }));
    });

    it('keeps the batch in execution while an assigned, out_for_delivery or in_transit dispatch remains', async () => {
        const ctx = setup({ remaining: [{ dispatch_id: 99 }] });

        await ctx.service.update(12, dto(DispatchStatusEnum.IN_TRANSIT), 7);

        expect(ctx.manager.query).toHaveBeenCalledWith(
            expect.stringContaining('ds.name = ANY($2::varchar[])'),
            [55, ['assigned', 'out_for_delivery', 'in_transit']],
        );
        expect(ctx.manager.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE route_batches'))).toBe(false);
        expect(ctx.manager.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO route_batch_events'))).toBe(false);
    });

    it('rejects illegal transitions without writing or publishing', async () => {
        const ctx = setup({ current: DispatchStatusEnum.OUT_FOR_DELIVERY });
        await expect(ctx.service.update(12, dto(DispatchStatusEnum.DELIVERED), 7)).rejects.toBeInstanceOf(DispatchStatusConflictException);
        expect(ctx.dispatchEvents.create).not.toHaveBeenCalled();
        expect(ctx.events.emit).not.toHaveBeenCalled();
    });

    it('requires policy evidence before delivered', async () => {
        const ctx = setup({ current: DispatchStatusEnum.IN_TRANSIT, evidence: false });
        await expect(ctx.service.update(12, dto(DispatchStatusEnum.DELIVERED), 7)).rejects.toBeInstanceOf(UnprocessableEntityException);
        expect(ctx.deliveryEvidences.existsByDispatchAndType).toHaveBeenCalledWith(12, 'signature', { manager: ctx.manager });
        expect(ctx.dispatchEvents.create).not.toHaveBeenCalled();
        expect(ctx.events.emit).not.toHaveBeenCalled();
    });

    it('queues the delivery result and stores its outbound version with the event in one transaction', async () => {
        const ctx = setup({ current: DispatchStatusEnum.IN_TRANSIT });
        const event = dto(DispatchStatusEnum.DELIVERED);
        await ctx.service.update(12, event, 7);

        expect(ctx.statusPublication.publish).toHaveBeenCalledWith(ctx.manager, expect.objectContaining({
            dispatchId: 12, status: DispatchStatusEnum.DELIVERED, previousStatus: DispatchStatusEnum.IN_TRANSIT,
            occurredAt: new Date(event.occurredAt),
        }));
        expect(ctx.dispatchEvents.create).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({ outboundRecordVersion: 1 }),
        }), { manager: ctx.manager });
    });

    it('returns the current state for a repeated eventId without duplicating writes or emissions', async () => {
        const ctx = setup({
            current: DispatchStatusEnum.IN_TRANSIT,
            previous: { dispatchId: 12, eventType: 'status_changed', createdAt: new Date(), metadata: { previousStatus: 'out_for_delivery' } },
        });
        const result = await ctx.service.update(12, dto(DispatchStatusEnum.IN_TRANSIT), 7);
        expect(result).toMatchObject({ dispatchId: 12, status: 'in_transit', previousStatus: 'out_for_delivery' });
        expect(ctx.dispatchEvents.create).not.toHaveBeenCalled();
        expect(ctx.events.emit).not.toHaveBeenCalled();
    });

    it('returns the current state for a repeated eventId after its batch has closed', async () => {
        const ctx = setup({
            current: DispatchStatusEnum.DELIVERED,
            batchStatus: 'closed',
            previous: { dispatchId: 12, eventType: 'status_changed', createdAt: new Date(), metadata: { previousStatus: 'in_transit' } },
        });
        const result = await ctx.service.update(12, dto(DispatchStatusEnum.DELIVERED), 7);
        expect(result).toMatchObject({ dispatchId: 12, status: 'delivered', previousStatus: 'in_transit' });
        expect(ctx.dispatchEvents.create).not.toHaveBeenCalled();
        expect(ctx.events.emit).not.toHaveBeenCalled();
    });

    it('returns an old repeated event before applying the occurredAt age limit', async () => {
        const ctx = setup({
            current: DispatchStatusEnum.IN_TRANSIT,
            previous: { dispatchId: 12, eventType: 'status_changed', createdAt: new Date(), metadata: { previousStatus: 'out_for_delivery' } },
        });
        const oldEvent = dto(DispatchStatusEnum.IN_TRANSIT);
        oldEvent.occurredAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
        await expect(ctx.service.update(12, oldEvent, 7)).resolves.toMatchObject({ status: 'in_transit' });
        expect(ctx.dispatchEvents.create).not.toHaveBeenCalled();
    });

    it('rejects a duplicate eventId reused by a different dispatch', async () => {
        const ctx = setup({ previous: { dispatchId: 90, eventType: 'status_changed', createdAt: new Date(), metadata: {} } });
        await expect(ctx.service.update(12, dto(DispatchStatusEnum.IN_TRANSIT), 7)).rejects.toBeInstanceOf(DispatchStatusConflictException);
    });

    it('rejects older events and a second active dispatch on the same route', async () => {
        const old = setup({ latest: [{ created_at: new Date(Date.now() + 1000) }] });
        await expect(old.service.update(12, dto(DispatchStatusEnum.IN_TRANSIT), 7)).rejects.toBeInstanceOf(DispatchStatusConflictException);

        const busy = setup({ active: [{ dispatch_id: 19 }] });
        await expect(busy.service.update(12, dto(DispatchStatusEnum.IN_TRANSIT), 7)).rejects.toBeInstanceOf(DispatchStatusConflictException);
    });

    it('rejects another driver and a missing dispatch', async () => {
        const other = setup({ batch: [{ id: 55, driver_id: 99, status: 'in_execution' }] });
        await expect(other.service.update(12, dto(DispatchStatusEnum.IN_TRANSIT), 7)).rejects.toBeInstanceOf(ForbiddenException);

        const missing = setup({ identity: [] });
        await expect(missing.service.update(404, dto(DispatchStatusEnum.IN_TRANSIT), 7)).rejects.toBeInstanceOf(DispatchNotFoundException);
    });
});
