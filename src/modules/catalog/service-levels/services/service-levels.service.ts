import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, ILike, Repository } from 'typeorm';
import { ServiceLevel } from '../entities/service-level.entity.js';
import { ServiceLevelDto } from '../dto/service-level.dto.js';
import { CreateServiceLevelDto } from '../dto/create-service-level.dto.js';
import { UpdateServiceLevelDto } from '../dto/update-service-level.dto.js';
import { FindAllServiceLevelsParamsDto } from '../dto/find-all-service-levels-params.dto.js';
import {
    ServiceLevelNotFoundException, ServiceLevelNameAlreadyExistsException, ServiceLevelInUseException,
} from '../exceptions/index.js';
import { DtoRepository, isUniqueViolation } from '../../../../shared/orm/index.js';
import { PaginationResponseDto } from '../../../../shared/dto/index.js';
import { FindOptions, MutationOptions } from '../../../../shared/dto/options.dto.js';
import { escapeLike } from '../../../../shared/utils/like.util.js';
import { DispatchesService } from '../../../dispatch/dispatches/services/dispatches.service.js';

@Injectable()
export class ServiceLevelsService {
    private readonly repo: DtoRepository<ServiceLevel>;

    constructor(
        @InjectRepository(ServiceLevel)
        private readonly rawRepo: Repository<ServiceLevel>,
        private readonly dispatchesService: DispatchesService,
    ) {
        this.repo = new DtoRepository(rawRepo);
    }

    // ── Queries ───────────────────────────────────────────────────────────────

    /** Priority hierarchy first (1 = highest), then the tighter target time, then id for a stable order. */
    async findAll<T>(dto: new () => T, params: FindAllServiceLevelsParamsDto): Promise<PaginationResponseDto<T>> {
        const base: FindOptionsWhere<ServiceLevel> = {
            // `?active=` (empty) is converted to null by the DTO: it means "no filter", not "active IS NULL".
            ...(params.active !== undefined && params.active !== null && { active: params.active }),
        };
        // The active filter must be repeated in every OR branch, or the search would bypass it.
        const search = params.search?.trim();
        const where: FindOptionsWhere<ServiceLevel> | FindOptionsWhere<ServiceLevel>[] = search
            ? [
                { ...base, name:        ILike(`%${escapeLike(search)}%`) },
                { ...base, description: ILike(`%${escapeLike(search)}%`) },
            ]
            : base;

        return this.repo.findPaginated({
            dto,
            pagination: params,
            where,
            order: { priorityLevel: 'ASC', targetTimeMin: 'ASC', id: 'ASC' },
        });
    }

    findOne<T>(dto: new () => T, where: FindOptionsWhere<ServiceLevel>, options: { throwException: false }): Promise<T | null>;
    findOne<T>(dto: new () => T, where: FindOptionsWhere<ServiceLevel>, options?: FindOptions): Promise<T>;
    async findOne<T>(dto: new () => T, where: FindOptionsWhere<ServiceLevel>, { throwException = true }: FindOptions = {}): Promise<T | null> {
        return this._findOne(dto, where, throwException);
    }

    findOneById<T>(dto: new () => T, id: number, options: { throwException: false }): Promise<T | null>;
    findOneById<T>(dto: new () => T, id: number, options?: FindOptions): Promise<T>;
    async findOneById<T>(dto: new () => T, id: number, { throwException = true }: FindOptions = {}): Promise<T | null> {
        return this._findOne(dto, { id }, throwException);
    }

    // ── Mutations ─────────────────────────────────────────────────────────────

    async create<T>(returnDto: new () => T, dto: CreateServiceLevelDto, options?: MutationOptions): Promise<T> {
        const repo = options?.manager?.getRepository(ServiceLevel) ?? this.rawRepo;

        // The DB's partial unique index is the real guard (see saveHandlingDuplicate); this check
        // just gives the common case a cheap early exit.
        if (await repo.existsBy({ name: dto.name })) throw new ServiceLevelNameAlreadyExistsException();

        const level         = repo.create();
        level.name          = dto.name;
        level.description   = dto.description || null;
        level.targetTimeMin = dto.targetTimeMin;
        level.priorityLevel = dto.priorityLevel;
        level.active        = true; // RF-A31, Escenario 1 — a new level is enabled right away

        const saved = await this.saveHandlingDuplicate(() => repo.save(level));

        const result = await new DtoRepository(repo).findOne({ dto: returnDto, where: { id: saved.id } });
        return result!;
    }

    async update<T>(returnDto: new () => T, id: number, dto: UpdateServiceLevelDto, options?: MutationOptions): Promise<T> {
        const repo = options?.manager?.getRepository(ServiceLevel) ?? this.rawRepo;

        const current = await this.findOneById(ServiceLevelDto, id);

        if (dto.name !== undefined && dto.name !== current.name) {
            if (await repo.existsBy({ name: dto.name })) throw new ServiceLevelNameAlreadyExistsException();
        }

        const payload: Record<string, any> = {};
        if (dto.name          !== undefined) payload.name          = dto.name;
        if (dto.description   !== undefined) payload.description   = dto.description || null; // '' or null clears it
        if (dto.targetTimeMin !== undefined) payload.targetTimeMin = dto.targetTimeMin;
        if (dto.priorityLevel !== undefined) payload.priorityLevel = dto.priorityLevel;
        if (dto.active        !== undefined) payload.active        = dto.active;

        // update() with an empty payload throws in TypeORM — an empty PUT is just a no-op read.
        if (Object.keys(payload).length > 0) {
            await this.saveHandlingDuplicate(() => repo.update(id, payload));
        }

        const result = await new DtoRepository(repo).findOne({ dto: returnDto, where: { id } });
        return result!;
    }

    /**
     * RF-A31, Escenario 3 — a level that dispatches in progress still use can't be deleted (that would
     * leave live orders without their commitment); the way out is disabling it (`active: false`),
     * which only stops it from being assigned to new orders. Without active dispatches it is a
     * regular soft delete — finished dispatches keep referencing the row.
     */
    async remove(id: number, options?: MutationOptions): Promise<void> {
        const repo = options?.manager?.getRepository(ServiceLevel) ?? this.rawRepo;
        await this.findOneById(ServiceLevelDto, id);

        if (await this.dispatchesService.hasActiveByServiceLevel(id, options)) throw new ServiceLevelInUseException();

        if (options?.hardDelete) {
            await repo.delete(id);
        } else {
            await repo.softDelete(id);
        }
    }

    // ── Private implementation ────────────────────────────────────────────────

    /** Two concurrent requests with the same name can both pass the pre-check — map the index error to the same 409. */
    private async saveHandlingDuplicate<R>(write: () => Promise<R>): Promise<R> {
        try {
            return await write();
        } catch (err) {
            if (isUniqueViolation(err)) throw new ServiceLevelNameAlreadyExistsException();
            throw err;
        }
    }

    private async _findOne<T>(dto: new () => T, where: FindOptionsWhere<ServiceLevel>, throwException: boolean): Promise<T | null> {
        const result = await this.repo.findOne({ dto, where });
        if (!result && throwException) throw new ServiceLevelNotFoundException();
        return result;
    }
}
