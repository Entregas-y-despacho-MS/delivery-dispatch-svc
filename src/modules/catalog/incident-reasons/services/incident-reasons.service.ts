import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, ILike, Repository } from 'typeorm';
import { IncidentReason } from '../entities/incident-reason.entity.js';
import { IncidentReasonDto } from '../dto/incident-reason.dto.js';
import { CreateIncidentReasonDto } from '../dto/create-incident-reason.dto.js';
import { UpdateIncidentReasonDto } from '../dto/update-incident-reason.dto.js';
import { FindAllIncidentReasonsParamsDto } from '../dto/find-all-incident-reasons-params.dto.js';
import { IncidentReasonNotFoundException, IncidentReasonCodeAlreadyExistsException } from '../exceptions/index.js';
import { DtoRepository, isUniqueViolation } from '../../../../shared/orm/index.js';
import { PaginationResponseDto } from '../../../../shared/dto/index.js';
import { FindOptions, MutationOptions } from '../../../../shared/dto/options.dto.js';
import { escapeLike } from '../../../../shared/utils/like.util.js';

/**
 * RF-A32 — catalog of incident reasons: alta/edición by the coordinator/supervisor (a unique code
 * + whether it requires photo evidence), and a read side the driver's mobile app uses to fetch and
 * cache the catalog offline. No delete: the way to retire a reason is disabling it (`active: false`),
 * which only stops it from being assigned to new incidents — the story has no reject-on-delete
 * scenario (unlike service_levels, nothing here is ever "in progress").
 */
@Injectable()
export class IncidentReasonsService {
    private readonly repo: DtoRepository<IncidentReason>;

    constructor(
        @InjectRepository(IncidentReason)
        private readonly rawRepo: Repository<IncidentReason>,
    ) {
        this.repo = new DtoRepository(rawRepo);
    }

    // ── Queries ───────────────────────────────────────────────────────────────

    async findAll<T>(dto: new () => T, params: FindAllIncidentReasonsParamsDto): Promise<PaginationResponseDto<T>> {
        const base: FindOptionsWhere<IncidentReason> = {
            // `?active=`/`?requiresEvidence=` (empty) is converted to null by the DTO: it means "no
            // filter", not "IS NULL" (that was a 500 in other catalogs before it was fixed there too).
            ...(params.active !== undefined && params.active !== null && { active: params.active }),
            ...(params.requiresEvidence !== undefined && params.requiresEvidence !== null && { requiresEvidence: params.requiresEvidence }),
        };
        // The other filters must be repeated in every OR branch, or the search would bypass them.
        const search = params.search?.trim();
        const where: FindOptionsWhere<IncidentReason> | FindOptionsWhere<IncidentReason>[] = search
            ? [
                { ...base, name: ILike(`%${escapeLike(search)}%`) },
                { ...base, code: ILike(`%${escapeLike(search)}%`) },
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

    findOne<T>(dto: new () => T, where: FindOptionsWhere<IncidentReason>, options: { throwException: false }): Promise<T | null>;
    findOne<T>(dto: new () => T, where: FindOptionsWhere<IncidentReason>, options?: FindOptions): Promise<T>;
    async findOne<T>(dto: new () => T, where: FindOptionsWhere<IncidentReason>, { throwException = true }: FindOptions = {}): Promise<T | null> {
        return this._findOne(dto, where, throwException);
    }

    findOneById<T>(dto: new () => T, id: number, options: { throwException: false }): Promise<T | null>;
    findOneById<T>(dto: new () => T, id: number, options?: FindOptions): Promise<T>;
    async findOneById<T>(dto: new () => T, id: number, { throwException = true }: FindOptions = {}): Promise<T | null> {
        return this._findOne(dto, { id }, throwException);
    }

    // ── Mutations ─────────────────────────────────────────────────────────────

    async create<T>(returnDto: new () => T, dto: CreateIncidentReasonDto, options?: MutationOptions): Promise<T> {
        const repo = options?.manager?.getRepository(IncidentReason) ?? this.rawRepo;

        // The DB's partial unique index is the real guard (see saveHandlingDuplicate); this check
        // just gives the common case a cheap early exit.
        if (await repo.existsBy({ code: dto.code })) throw new IncidentReasonCodeAlreadyExistsException();

        const reason            = repo.create();
        reason.code              = dto.code;
        reason.name              = dto.name;
        reason.requiresEvidence  = dto.requiresEvidence;
        reason.active            = true; // RF-A32, Escenario 1 — a new reason is enabled right away

        const saved = await this.saveHandlingDuplicate(() => repo.save(reason));

        const result = await new DtoRepository(repo).findOne({ dto: returnDto, where: { id: saved.id } });
        return result!;
    }

    async update<T>(returnDto: new () => T, id: number, dto: UpdateIncidentReasonDto, options?: MutationOptions): Promise<T> {
        const repo = options?.manager?.getRepository(IncidentReason) ?? this.rawRepo;

        const current = await this.findOneById(IncidentReasonDto, id);

        if (dto.code !== undefined && dto.code !== current.code) {
            if (await repo.existsBy({ code: dto.code })) throw new IncidentReasonCodeAlreadyExistsException();
        }

        const payload: Record<string, any> = {};
        if (dto.code             !== undefined) payload.code             = dto.code;
        if (dto.name             !== undefined) payload.name             = dto.name;
        if (dto.requiresEvidence !== undefined) payload.requiresEvidence = dto.requiresEvidence;
        if (dto.active           !== undefined) payload.active           = dto.active;

        // update() with an empty payload throws in TypeORM — an empty PUT is just a no-op read.
        if (Object.keys(payload).length > 0) {
            await this.saveHandlingDuplicate(() => repo.update(id, payload));
        }

        const result = await new DtoRepository(repo).findOne({ dto: returnDto, where: { id } });
        return result!;
    }

    // ── Private implementation ────────────────────────────────────────────────

    /** Two concurrent requests with the same code can both pass the pre-check — map the index error to the same 409. */
    private async saveHandlingDuplicate<R>(write: () => Promise<R>): Promise<R> {
        try {
            return await write();
        } catch (err) {
            if (isUniqueViolation(err)) throw new IncidentReasonCodeAlreadyExistsException();
            throw err;
        }
    }

    private async _findOne<T>(dto: new () => T, where: FindOptionsWhere<IncidentReason>, throwException: boolean): Promise<T | null> {
        const result = await this.repo.findOne({ dto, where });
        if (!result && throwException) throw new IncidentReasonNotFoundException();
        return result;
    }
}
