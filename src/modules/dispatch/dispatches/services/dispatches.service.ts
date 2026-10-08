import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Dispatch } from '../entities/dispatch.entity.js';
import { DispatchStatus } from '../../dispatch-statuses/entities/dispatch-status.entity.js';
import { DispatchNotFoundException } from '../exceptions/index.js';
import { DriverAssignmentDto } from '../dto/driver-assignment.dto.js';
import { DriverAssignmentsResponseDto } from '../dto/driver-assignments-response.dto.js';
import { DtoRepository } from '../../../../shared/orm/index.js';
import { MutationOptions } from '../../../../shared/dto/options.dto.js';
import { DispatchStatusEnum } from '../../../../shared/enums/index.js';

// Statuses a dispatch never leaves: a delivered or returned order is finished.
export const FINAL_STATUSES: string[] = [DispatchStatusEnum.DELIVERED, DispatchStatusEnum.RETURNED];

// A dispatch is "active" (in progress) until it reaches a final state. `not_delivered` is left out on
// purpose: it is a failed attempt that can still be rescheduled, but the business definition used for
// RF-A31 is "en proceso de entrega" = pending or in transit. Change it here if that ever widens.
const ACTIVE_STATUSES = [DispatchStatusEnum.PENDING, DispatchStatusEnum.IN_TRANSIT];

// Generic, direct operations only — no business logic. Orchestration (idempotency, ordering,
// transactions across modules) lives in app/sync, not here.
@Injectable()
export class DispatchesService {
    private readonly repo: DtoRepository<Dispatch>;

    constructor(
        @InjectRepository(Dispatch)
        private readonly rawRepo: Repository<Dispatch>,
    ) {
        this.repo = new DtoRepository(rawRepo);
    }

    /**
     * The driver's stops for a shift date (RF-U02): every dispatch of the route batch assigned to
     * them that day, in visit order (stops without a number go last). Closed stops are included —
     * the app shows the day's progress. A driver without a route gets an empty list, never an error.
     * `lastModifiedAt` is the newest `updatedAt` among the stops, so the app can tell the route changed.
     */
    async findDriverAssignments(driverId: number, shiftDate: string): Promise<DriverAssignmentsResponseDto> {
        const data = await this.repo.find<DriverAssignmentDto>({
            dto: DriverAssignmentDto,
            where: { routeBatch: { driverId, shiftDate } },
            order: { sequenceOrder: { direction: 'ASC', nulls: 'LAST' }, id: 'ASC' },
        });
        const lastModifiedAt = data.reduce<Date | null>((latest, stop) => (latest === null || stop.updatedAt > latest ? stop.updatedAt : latest), null);
        return { date: shiftDate, lastModifiedAt, data };
    }

    async existsById(id: number, options?: MutationOptions): Promise<boolean> {
        const repo = options?.manager?.getRepository(Dispatch) ?? this.rawRepo;
        return repo.existsBy({ id });
    }

    /** Current status name of a dispatch, or null when it does not exist. */
    async getStatusName(dispatchId: number, options?: MutationOptions): Promise<string | null> {
        const repo = options?.manager?.getRepository(Dispatch) ?? this.rawRepo;
        const dispatch = await repo.findOne({ where: { id: dispatchId }, relations: { dispatchStatus: true }, select: { id: true, dispatchStatus: { id: true, name: true } } });
        return dispatch?.dispatchStatus?.name ?? null;
    }

    /** Name of a dispatch status by id, or null when there is no such status. */
    async getStatusNameById(statusId: number, options?: MutationOptions): Promise<string | null> {
        const repo = options?.manager?.getRepository(DispatchStatus) ?? this.rawRepo.manager.getRepository(DispatchStatus);
        return (await repo.findOne({ where: { id: statusId }, select: { id: true, name: true } }))?.name ?? null;
    }

    /** Whether the dispatch belongs to a route batch assigned to this driver (a driver may only report on their own). */
    async isAssignedToDriver(dispatchId: number, driverId: number, options?: MutationOptions): Promise<boolean> {
        const repo = options?.manager?.getRepository(Dispatch) ?? this.rawRepo;
        return repo.exists({ where: { id: dispatchId, routeBatch: { driverId } } });
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

    /**
     * Overwrites the dispatch's last known position (RF-U11) — but only if `point` is actually newer
     * than what is already stored. One conditional UPDATE, not a read-then-compare-then-write: two
     * concurrent reports for the same dispatch (or an out-of-order point in a buffered batch) must
     * never let an older point undo a newer one, and a two-step check has a race window this doesn't.
     * Returns whether it actually wrote (false = the stored position was already at least as new —
     * not an error, the caller decides what that means, e.g. `stale` in app/tracking).
     */
    async updateLocation(dispatchId: number, point: { latitude: number; longitude: number; recordedAt: Date }, options?: MutationOptions): Promise<boolean> {
        const repo = options?.manager?.getRepository(Dispatch) ?? this.rawRepo;
        const result = await repo.createQueryBuilder()
            .update(Dispatch)
            .set({ lastLatitude: point.latitude, lastLongitude: point.longitude, lastLocationAt: point.recordedAt })
            .where('dispatch_id = :id', { id: dispatchId })
            .andWhere('(last_location_at IS NULL OR last_location_at < :recordedAt)', { recordedAt: point.recordedAt })
            .execute();
        return (result.affected ?? 0) > 0;
    }
}
