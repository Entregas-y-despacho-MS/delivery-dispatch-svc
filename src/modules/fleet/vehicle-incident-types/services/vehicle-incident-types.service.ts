import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, ILike, Repository } from 'typeorm';
import { VehicleIncidentType } from '../entities/vehicle-incident-type.entity.js';
import { VehicleIncidentTypeDto } from '../dto/vehicle-incident-type.dto.js';
import { CreateVehicleIncidentTypeDto } from '../dto/create-vehicle-incident-type.dto.js';
import { UpdateVehicleIncidentTypeDto } from '../dto/update-vehicle-incident-type.dto.js';
import { FindAllVehicleIncidentTypesParamsDto } from '../dto/find-all-vehicle-incident-types-params.dto.js';
import { VehicleIncidentTypeNotFoundException, VehicleIncidentTypeCodeAlreadyExistsException } from '../exceptions/index.js';
import { DtoRepository, isUniqueViolation } from '../../../../shared/orm/index.js';
import { PaginationResponseDto } from '../../../../shared/dto/index.js';
import { FindOptions, MutationOptions } from '../../../../shared/dto/options.dto.js';
import { escapeLike } from '../../../../shared/utils/like.util.js';

/**
 * RF-A34 — catalog of vehicle incident types: alta/edición by the fleet supervisor (a unique code,
 * a name, a mandatory severity, and whether the type disables the vehicle it's registered against),
 * and the read side VehicleMaintenancesService uses to decide whether to trigger that disabling.
 * No delete: the way to retire a type is out of scope of the story's 3 escenarios (none asks for
 * it), and the pre-existing table comment already says types are referenced by maintenance history.
 */
@Injectable()
export class VehicleIncidentTypesService {
    private readonly repo: DtoRepository<VehicleIncidentType>;

    constructor(
        @InjectRepository(VehicleIncidentType)
        private readonly rawRepo: Repository<VehicleIncidentType>,
    ) {
        this.repo = new DtoRepository(rawRepo);
    }

    // ── Queries ───────────────────────────────────────────────────────────────

    async findAll<T>(dto: new () => T, params: FindAllVehicleIncidentTypesParamsDto): Promise<PaginationResponseDto<T>> {
        const base: FindOptionsWhere<VehicleIncidentType> = {
            ...(params.severity !== undefined && { severity: params.severity }),
            // `?disablesVehicle=` (empty) is converted to null by the DTO: it means "no filter".
            ...(params.disablesVehicle !== undefined && params.disablesVehicle !== null && { disablesVehicle: params.disablesVehicle }),
        };
        // The other filters must be repeated in every OR branch, or the search would bypass them.
        const search = params.search?.trim();
        const where: FindOptionsWhere<VehicleIncidentType> | FindOptionsWhere<VehicleIncidentType>[] = search
            ? [
                { ...base, code: ILike(`%${escapeLike(search)}%`) },
                { ...base, name: ILike(`%${escapeLike(search)}%`) },
            ]
            : base;

        const sortBy = params.sortBy ?? 'name';
        return this.repo.findPaginated({
            dto,
            pagination: params,
            where,
            // Every sort ends in id, so a page never repeats or skips a row when the field ties.
            order: { [sortBy]: (params.sortOrder ?? 'asc').toUpperCase() as 'ASC' | 'DESC', id: 'ASC' },
        });
    }

    findOne<T>(dto: new () => T, where: FindOptionsWhere<VehicleIncidentType>, options: { throwException: false }): Promise<T | null>;
    findOne<T>(dto: new () => T, where: FindOptionsWhere<VehicleIncidentType>, options?: FindOptions): Promise<T>;
    async findOne<T>(dto: new () => T, where: FindOptionsWhere<VehicleIncidentType>, { throwException = true }: FindOptions = {}): Promise<T | null> {
        return this._findOne(dto, where, throwException);
    }

    findOneById<T>(dto: new () => T, id: number, options: { throwException: false }): Promise<T | null>;
    findOneById<T>(dto: new () => T, id: number, options?: FindOptions): Promise<T>;
    async findOneById<T>(dto: new () => T, id: number, { throwException = true }: FindOptions = {}): Promise<T | null> {
        return this._findOne(dto, { id }, throwException);
    }

    /** Whether registering an incident of this type disables the vehicle (RF-A34, Escenario 2). Used by VehicleMaintenancesService. */
    async getDisablesVehicle(id: number, options?: MutationOptions): Promise<boolean | null> {
        const repo = options?.manager?.getRepository(VehicleIncidentType) ?? this.rawRepo;
        const row = await repo.findOne({ where: { id }, select: { id: true, disablesVehicle: true } });
        return row?.disablesVehicle ?? null;
    }

    // ── Mutations ─────────────────────────────────────────────────────────────

    async create<T>(returnDto: new () => T, dto: CreateVehicleIncidentTypeDto, options?: MutationOptions): Promise<T> {
        const repo = options?.manager?.getRepository(VehicleIncidentType) ?? this.rawRepo;

        // The DB's partial unique indexes are the real guard (see saveHandlingDuplicate); these
        // checks just give the common case a cheap early exit.
        if (await repo.existsBy({ code: dto.code })) throw new VehicleIncidentTypeCodeAlreadyExistsException();
        if (await repo.existsBy({ name: dto.name })) throw new VehicleIncidentTypeCodeAlreadyExistsException();

        const type            = repo.create();
        type.code              = dto.code;
        type.name               = dto.name;
        type.severity            = dto.severity;
        type.disablesVehicle      = dto.disablesVehicle;

        const saved = await this.saveHandlingDuplicate(() => repo.save(type));

        const result = await new DtoRepository(repo).findOne({ dto: returnDto, where: { id: saved.id } });
        return result!;
    }

    async update<T>(returnDto: new () => T, id: number, dto: UpdateVehicleIncidentTypeDto, options?: MutationOptions): Promise<T> {
        const repo = options?.manager?.getRepository(VehicleIncidentType) ?? this.rawRepo;

        const current = await this.findOneById(VehicleIncidentTypeDto, id);

        if (dto.code !== undefined && dto.code !== current.code) {
            if (await repo.existsBy({ code: dto.code })) throw new VehicleIncidentTypeCodeAlreadyExistsException();
        }
        if (dto.name !== undefined && dto.name !== current.name) {
            if (await repo.existsBy({ name: dto.name })) throw new VehicleIncidentTypeCodeAlreadyExistsException();
        }

        const payload: Record<string, any> = {};
        if (dto.code            !== undefined) payload.code            = dto.code;
        if (dto.name            !== undefined) payload.name            = dto.name;
        if (dto.severity        !== undefined) payload.severity        = dto.severity;
        if (dto.disablesVehicle !== undefined) payload.disablesVehicle = dto.disablesVehicle;

        // update() with an empty payload throws in TypeORM — an empty PUT is just a no-op read.
        if (Object.keys(payload).length > 0) {
            await this.saveHandlingDuplicate(() => repo.update(id, payload));
        }

        const result = await new DtoRepository(repo).findOne({ dto: returnDto, where: { id } });
        return result!;
    }

    // ── Private implementation ────────────────────────────────────────────────

    /** Two concurrent requests with the same name or code can both pass the pre-checks — map the index error to the same 409. */
    private async saveHandlingDuplicate<R>(write: () => Promise<R>): Promise<R> {
        try {
            return await write();
        } catch (err) {
            if (isUniqueViolation(err)) throw new VehicleIncidentTypeCodeAlreadyExistsException();
            throw err;
        }
    }

    private async _findOne<T>(dto: new () => T, where: FindOptionsWhere<VehicleIncidentType>, throwException: boolean): Promise<T | null> {
        const result = await this.repo.findOne({ dto, where });
        if (!result && throwException) throw new VehicleIncidentTypeNotFoundException();
        return result;
    }
}
