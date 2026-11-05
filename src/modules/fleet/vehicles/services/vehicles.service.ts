import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, ILike, QueryFailedError, Repository } from 'typeorm';
import { escapeLike } from '../../../../shared/utils/like.util.js';
import { Vehicle } from '../entities/vehicle.entity.js';
import { VehicleStatus } from '../../vehicle-statuses/entities/vehicle-status.entity.js';
import { AuditLog } from '../../../audit/audit-logs/entities/audit-log.entity.js';
import { VehicleDto } from '../dto/vehicle.dto.js';
import { CreateVehicleDto } from '../dto/create-vehicle.dto.js';
import { UpdateVehicleDto } from '../dto/update-vehicle.dto.js';
import { ChangeVehicleStatusDto } from '../dto/change-vehicle-status.dto.js';
import { FindAllVehiclesParamsDto } from '../dto/find-all-vehicles-params.dto.js';
import {
    VehicleNotFoundException, VehiclePlateAlreadyExistsException,
    VehicleHasActiveBatchesException, VehicleStatusChangeRequiresPatchException,
} from '../exceptions/index.js';
import { DtoRepository } from '../../../../shared/orm/index.js';
import { PaginationResponseDto } from '../../../../shared/dto/index.js';
import { FindOptions, MutationOptions } from '../../../../shared/dto/options.dto.js';
import { VehicleStatusEnum } from '../../../../shared/enums/index.js';

// Postgres error code for unique_violation.
const UNIQUE_VIOLATION = '23505';
const VEHICLE_STATUS_CHANGED_ACTION = 'vehicle_status_changed';

@Injectable()
export class VehiclesService {
    private readonly repo: DtoRepository<Vehicle>;

    constructor(
        @InjectRepository(Vehicle)
        private readonly rawRepo: Repository<Vehicle>,
        @InjectRepository(VehicleStatus)
        private readonly statusRepo: Repository<VehicleStatus>,
    ) {
        this.repo = new DtoRepository(rawRepo);
    }

    // ── Queries ───────────────────────────────────────────────────────────────

    async findAll<T>(dto: new () => T, params: FindAllVehiclesParamsDto): Promise<PaginationResponseDto<T>> {
        const base: FindOptionsWhere<Vehicle> = {
            ...(params.vehicleStatusId !== undefined && { vehicleStatusId: params.vehicleStatusId }),
        };
        // The status filter must be repeated in every OR branch, or the search would bypass it.
        const search  = params.search?.trim();
        const pattern = search ? `%${escapeLike(search)}%` : undefined;
        const where: FindOptionsWhere<Vehicle> | FindOptionsWhere<Vehicle>[] = pattern
            ? [
                { ...base, plate: ILike(pattern) },
                { ...base, model: ILike(pattern) },
                { ...base, type:  ILike(pattern) },
            ]
            : base;

        return this.repo.findPaginated({ dto, pagination: params, where, order: { plate: 'ASC' } });
    }

    findOne<T>(dto: new () => T, where: FindOptionsWhere<Vehicle>, options: { throwException: false }): Promise<T | null>;
    findOne<T>(dto: new () => T, where: FindOptionsWhere<Vehicle>, options?: FindOptions): Promise<T>;
    async findOne<T>(dto: new () => T, where: FindOptionsWhere<Vehicle>, { throwException = true }: FindOptions = {}): Promise<T | null> {
        return this._findOne(dto, where, throwException);
    }

    findOneById<T>(dto: new () => T, id: number, options: { throwException: false }): Promise<T | null>;
    findOneById<T>(dto: new () => T, id: number, options?: FindOptions): Promise<T>;
    async findOneById<T>(dto: new () => T, id: number, { throwException = true }: FindOptions = {}): Promise<T | null> {
        return this._findOne(dto, { id }, throwException);
    }

    async existsById(id: number, options?: MutationOptions): Promise<boolean> {
        const repo = options?.manager?.getRepository(Vehicle) ?? this.rawRepo;
        return repo.existsBy({ id });
    }

    // ── Mutations ─────────────────────────────────────────────────────────────

    async create<T>(returnDto: new () => T, dto: CreateVehicleDto, options?: MutationOptions): Promise<T> {
        const repo       = options?.manager?.getRepository(Vehicle) ?? this.rawRepo;
        const statusRepo = options?.manager?.getRepository(VehicleStatus) ?? this.statusRepo;

        // RF-A30, Escenario 2 — duplicate plate. The DB's partial unique index is the real guard
        // (see saveHandlingDuplicate); this check just gives the common case a cheap early exit.
        if (await repo.existsBy({ plate: dto.plate })) throw new VehiclePlateAlreadyExistsException();

        // RF-A30, Escenario 1 — new vehicles start as "available" for route assignment, which is the
        // `active` operational status (schema has active | maintenance | out_of_service).
        const initialStatus = await statusRepo.findOneByOrFail({ name: VehicleStatusEnum.ACTIVE });

        const vehicle           = repo.create();
        vehicle.vehicleStatusId = initialStatus.id;
        vehicle.type            = dto.type;
        vehicle.model           = dto.model;
        vehicle.plate           = dto.plate;
        vehicle.capacityKg      = dto.capacityKg;
        vehicle.capacityM3      = dto.capacityM3;

        const saved = await this.saveHandlingDuplicate(() => repo.save(vehicle));

        const result = await new DtoRepository(repo).findOne({ dto: returnDto, where: { id: saved.id } });
        return result!;
    }

    async update<T>(returnDto: new () => T, id: number, dto: UpdateVehicleDto, options?: MutationOptions): Promise<T> {
        const repo       = options?.manager?.getRepository(Vehicle) ?? this.rawRepo;

        const current = await this.findOneById(VehicleDto, id);

        // A status change has additional safety and audit requirements. Keep PUT for regular
        // vehicle edits, but route every status transition through the reason-bearing PATCH.
        if (dto.vehicleStatusId !== undefined) throw new VehicleStatusChangeRequiresPatchException();

        if (dto.plate !== undefined && dto.plate !== current.plate) {
            if (await repo.existsBy({ plate: dto.plate })) throw new VehiclePlateAlreadyExistsException();
        }
        const payload: Record<string, any> = {};
        if (dto.type            !== undefined) payload.type            = dto.type;
        if (dto.model           !== undefined) payload.model           = dto.model;
        if (dto.plate           !== undefined) payload.plate           = dto.plate;
        if (dto.capacityKg      !== undefined) payload.capacityKg      = dto.capacityKg;
        if (dto.capacityM3      !== undefined) payload.capacityM3      = dto.capacityM3;

        // update() with an empty payload throws in TypeORM — an empty PUT is just a no-op read.
        if (Object.keys(payload).length > 0) {
            await this.saveHandlingDuplicate(() => repo.update(id, payload));
        }

        const result = await new DtoRepository(repo).findOne({ dto: returnDto, where: { id } });
        return result!;
    }

    /**
     * Looks up the vehicle_status by name and sets it directly — used by RF-A34's incident
     * trigger (VehicleMaintenancesService.create()), and by anything else that needs to move a
     * vehicle to a status by name rather than by id. Throws VehicleNotFoundException if the
     * vehicle doesn't exist.
     */
    async setStatusByName(id: number, statusName: VehicleStatusEnum, options?: MutationOptions): Promise<void> {
        const repo       = options?.manager?.getRepository(Vehicle) ?? this.rawRepo;
        const statusRepo = options?.manager?.getRepository(VehicleStatus) ?? this.statusRepo;

        if (!(await repo.existsBy({ id }))) throw new VehicleNotFoundException();

        const status = await statusRepo.findOneByOrFail({ name: statusName });
        await repo.update(id, { vehicleStatusId: status.id });
    }

    /**
     * Performs the user-requested operational status transition with its guard and audit entry
     * in one transaction. setStatusByName remains the shared write path so existing maintenance
     * incident behavior is unchanged.
     */
    async changeStatus(id: number, dto: ChangeVehicleStatusDto, userId: number): Promise<VehicleDto> {
        return this.rawRepo.manager.transaction(async (manager) => {
            const currentRows = await manager.query(
                `SELECT s.name AS status
                 FROM vehicles v
                 JOIN vehicle_statuses s ON s.vehicle_status_id = v.vehicle_status_id
                 WHERE v.vehicle_id = $1 AND v.deleted_at IS NULL
                 FOR UPDATE OF v`,
                [id],
            ) as { status: VehicleStatusEnum }[];

            if (currentRows.length === 0) throw new VehicleNotFoundException();
            const previousStatus = currentRows[0].status;

            if (previousStatus !== dto.status && dto.status !== VehicleStatusEnum.ACTIVE) {
                const activeBatches = await manager.query(
                    `SELECT route_batch_id AS id, shift_date AS "shiftDate"
                     FROM route_batches
                     WHERE vehicle_id = $1 AND status IN ('confirmed', 'in_execution')
                     ORDER BY shift_date, route_batch_id`,
                    [id],
                ) as { id: number; shiftDate: string }[];

                if (activeBatches.length > 0) throw new VehicleHasActiveBatchesException(activeBatches);
            }

            if (previousStatus !== dto.status) {
                await this.setStatusByName(id, dto.status, { manager });

                const auditRepo = manager.getRepository(AuditLog);
                await auditRepo.save(auditRepo.create({
                    userId,
                    action: VEHICLE_STATUS_CHANGED_ACTION,
                    detail: JSON.stringify({
                        vehicleId: id,
                        previousStatus,
                        newStatus: dto.status,
                        reason: dto.reason,
                    }),
                }));
            }

            return (await new DtoRepository(manager.getRepository(Vehicle))
                .findOne({ dto: VehicleDto, where: { id } }))!;
        });
    }

    async remove(id: number, options?: MutationOptions): Promise<void> {
        const repo = options?.manager?.getRepository(Vehicle) ?? this.rawRepo;
        await this.findOneById(VehicleDto, id);
        if (options?.hardDelete) {
            await repo.delete(id);
        } else {
            await repo.softDelete(id);
        }
    }

    // ── Private implementation ────────────────────────────────────────────────

    /**
     * Two concurrent requests with the same plate can both pass the existsBy() pre-check — the
     * partial unique index (uq_vehicles_plate) then rejects the second write. Map that to the same
     * 409 instead of letting it surface as a 500.
     */
    private async saveHandlingDuplicate<R>(write: () => Promise<R>): Promise<R> {
        try {
            return await write();
        } catch (err) {
            const code = err instanceof QueryFailedError ? (err.driverError as { code?: string } | undefined)?.code : undefined;
            if (code === UNIQUE_VIOLATION) throw new VehiclePlateAlreadyExistsException();
            throw err;
        }
    }

    private async _findOne<T>(dto: new () => T, where: FindOptionsWhere<Vehicle>, throwException: boolean): Promise<T | null> {
        const result = await this.repo.findOne({ dto, where });
        if (!result && throwException) throw new VehicleNotFoundException();
        return result;
    }
}
