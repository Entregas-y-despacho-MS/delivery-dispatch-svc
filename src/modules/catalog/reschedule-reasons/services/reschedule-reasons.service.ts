import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, ILike, Repository } from 'typeorm';
import { RescheduleReason } from '../entities/reschedule-reason.entity.js';
import { RescheduleReasonDto } from '../dto/reschedule-reason.dto.js';
import { CreateRescheduleReasonDto } from '../dto/create-reschedule-reason.dto.js';
import { UpdateRescheduleReasonDto } from '../dto/update-reschedule-reason.dto.js';
import { FindAllRescheduleReasonsParamsDto } from '../dto/find-all-reschedule-reasons-params.dto.js';
import { RescheduleReasonNotFoundException, RescheduleReasonNameAlreadyExistsException } from '../exceptions/index.js';
import { DtoRepository, isUniqueViolation } from '../../../../shared/orm/index.js';
import { PaginationResponseDto } from '../../../../shared/dto/index.js';
import { FindOptions, MutationOptions } from '../../../../shared/dto/options.dto.js';
import { escapeLike } from '../../../../shared/utils/like.util.js';

/**
 * RF-A33 — catalog of reschedule/reassignment reasons: alta/edición by the dispatch coordinator and
 * the operations supervisor (a name, an optional description, and the category a reason is
 * classified under), and the read side the reschedule/reassignment modal of the operations panel
 * uses. No delete: the way to retire a reason is disabling it (`active: false`), which only stops it
 * from being assigned to new reschedules — the story has no reject-on-delete scenario (unlike
 * service_levels), and no delete scenario at all (unlike incident_reasons, which at least has one
 * for disabling — this one only has alta and duplicate prevention).
 */
@Injectable()
export class RescheduleReasonsService {
    private readonly repo: DtoRepository<RescheduleReason>;

    constructor(
        @InjectRepository(RescheduleReason)
        private readonly rawRepo: Repository<RescheduleReason>,
    ) {
        this.repo = new DtoRepository(rawRepo);
    }

    // ── Queries ───────────────────────────────────────────────────────────────

    async findAll<T>(dto: new () => T, params: FindAllRescheduleReasonsParamsDto): Promise<PaginationResponseDto<T>> {
        const base: FindOptionsWhere<RescheduleReason> = {
            // `?active=` (empty) is converted to null by the DTO: it means "no filter", not "IS NULL"
            // (that was a 500 in other catalogs before it was fixed there too).
            ...(params.active !== undefined && params.active !== null && { active: params.active }),
            ...(params.category !== undefined && { category: params.category }),
        };
        // The other filters must be repeated in every OR branch, or the search would bypass them.
        const search = params.search?.trim();
        const where: FindOptionsWhere<RescheduleReason> | FindOptionsWhere<RescheduleReason>[] = search
            ? [
                { ...base, name: ILike(`%${escapeLike(search)}%`) },
                { ...base, description: ILike(`%${escapeLike(search)}%`) },
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

    findOne<T>(dto: new () => T, where: FindOptionsWhere<RescheduleReason>, options: { throwException: false }): Promise<T | null>;
    findOne<T>(dto: new () => T, where: FindOptionsWhere<RescheduleReason>, options?: FindOptions): Promise<T>;
    async findOne<T>(dto: new () => T, where: FindOptionsWhere<RescheduleReason>, { throwException = true }: FindOptions = {}): Promise<T | null> {
        return this._findOne(dto, where, throwException);
    }

    findOneById<T>(dto: new () => T, id: number, options: { throwException: false }): Promise<T | null>;
    findOneById<T>(dto: new () => T, id: number, options?: FindOptions): Promise<T>;
    async findOneById<T>(dto: new () => T, id: number, { throwException = true }: FindOptions = {}): Promise<T | null> {
        return this._findOne(dto, { id }, throwException);
    }

    // ── Mutations ─────────────────────────────────────────────────────────────

    async create<T>(returnDto: new () => T, dto: CreateRescheduleReasonDto, options?: MutationOptions): Promise<T> {
        const repo = options?.manager?.getRepository(RescheduleReason) ?? this.rawRepo;

        // The DB's partial unique index is the real guard (see saveHandlingDuplicate); this check
        // just gives the common case a cheap early exit.
        if (await repo.existsBy({ name: dto.name })) throw new RescheduleReasonNameAlreadyExistsException();

        const reason           = repo.create();
        reason.name             = dto.name;
        reason.description      = dto.description || null;
        reason.category         = dto.category;
        reason.active           = true; // RF-A33, Escenario 1 — a new reason is enabled right away

        const saved = await this.saveHandlingDuplicate(() => repo.save(reason));

        const result = await new DtoRepository(repo).findOne({ dto: returnDto, where: { id: saved.id } });
        return result!;
    }

    async update<T>(returnDto: new () => T, id: number, dto: UpdateRescheduleReasonDto, options?: MutationOptions): Promise<T> {
        const repo = options?.manager?.getRepository(RescheduleReason) ?? this.rawRepo;

        const current = await this.findOneById(RescheduleReasonDto, id);

        if (dto.name !== undefined && dto.name !== current.name) {
            if (await repo.existsBy({ name: dto.name })) throw new RescheduleReasonNameAlreadyExistsException();
        }

        const payload: Record<string, any> = {};
        if (dto.name        !== undefined) payload.name        = dto.name;
        if (dto.description !== undefined) payload.description = dto.description || null; // '' or null clears it
        if (dto.category    !== undefined) payload.category    = dto.category;
        if (dto.active      !== undefined) payload.active      = dto.active;

        // update() with an empty payload throws in TypeORM — an empty PUT is just a no-op read.
        if (Object.keys(payload).length > 0) {
            await this.saveHandlingDuplicate(() => repo.update(id, payload));
        }

        const result = await new DtoRepository(repo).findOne({ dto: returnDto, where: { id } });
        return result!;
    }

    // ── Private implementation ────────────────────────────────────────────────

    /** Two concurrent requests with the same name can both pass the pre-check — map the index error to the same 409. */
    private async saveHandlingDuplicate<R>(write: () => Promise<R>): Promise<R> {
        try {
            return await write();
        } catch (err) {
            if (isUniqueViolation(err)) throw new RescheduleReasonNameAlreadyExistsException();
            throw err;
        }
    }

    private async _findOne<T>(dto: new () => T, where: FindOptionsWhere<RescheduleReason>, throwException: boolean): Promise<T | null> {
        const result = await this.repo.findOne({ dto, where });
        if (!result && throwException) throw new RescheduleReasonNotFoundException();
        return result;
    }
}
