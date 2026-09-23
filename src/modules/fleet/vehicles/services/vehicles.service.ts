import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, ILike, QueryFailedError, Repository } from 'typeorm';
import { Vehicle } from '../entities/vehicle.entity.js';
import { VehicleStatus } from '../../vehicle-statuses/entities/vehicle-status.entity.js';
import { VehicleDto } from '../dto/vehicle.dto.js';
import { CreateVehicleDto } from '../dto/create-vehicle.dto.js';
import { UpdateVehicleDto } from '../dto/update-vehicle.dto.js';
import { FindAllVehiclesParamsDto } from '../dto/find-all-vehicles-params.dto.js';
import {
    VehicleNotFoundException, VehiclePlateAlreadyExistsException, InvalidVehicleStatusException,
} from '../exceptions/index.js';
import { DtoRepository } from '../../../../shared/orm/index.js';
import { PaginationResponseDto } from '../../../../shared/dto/index.js';
import { FindOptions, MutationOptions } from '../../../../shared/dto/options.dto.js';
import { VehicleStatusEnum } from '../../../../shared/enums/index.js';

// Postgres error code for unique_violation.
const UNIQUE_VIOLATION = '23505';

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
        const where: FindOptionsWhere<Vehicle> | FindOptionsWhere<Vehicle>[] = params.search
            ? [
                { ...base, plate: ILike(`%${params.search}%`) },
                { ...base, model: ILike(`%${params.search}%`) },
                { ...base, type:  ILike(`%${params.search}%`) },
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
        const statusRepo = options?.manager?.getRepository(VehicleStatus) ?? this.statusRepo;

        const current = await this.findOneById(VehicleDto, id);

        if (dto.plate !== undefined && dto.plate !== current.plate) {
            if (await repo.existsBy({ plate: dto.plate })) throw new VehiclePlateAlreadyExistsException();
        }
        if (dto.vehicleStatusId !== undefined && !(await statusRepo.existsBy({ id: dto.vehicleStatusId }))) {
            throw new InvalidVehicleStatusException();
        }

        const payload: Record<string, any> = {};
        if (dto.type            !== undefined) payload.type            = dto.type;
        if (dto.model           !== undefined) payload.model           = dto.model;
        if (dto.plate           !== undefined) payload.plate           = dto.plate;
        if (dto.capacityKg      !== undefined) payload.capacityKg      = dto.capacityKg;
        if (dto.capacityM3      !== undefined) payload.capacityM3      = dto.capacityM3;
        if (dto.vehicleStatusId !== undefined) payload.vehicleStatusId = dto.vehicleStatusId;

        // update() with an empty payload throws in TypeORM — an empty PUT is just a no-op read.
        if (Object.keys(payload).length > 0) {
            await this.saveHandlingDuplicate(() => repo.update(id, payload));
        }

        const result = await new DtoRepository(repo).findOne({ dto: returnDto, where: { id } });
        return result!;
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
