import { plainToInstance } from 'class-transformer';
import { FindManyOptions, FindOneOptions, ObjectLiteral, Repository } from 'typeorm';
import { buildFindOptions } from './build-find-options.js';
import { PaginationParamsDto } from '../dto/pagination-params.dto.js';
import { PaginationResponseDto } from '../dto/pagination-response.dto.js';

// Replaces `select` and `relations` with a `dto` field — they are derived automatically.
type FindOneDto<E, T>  = Omit<FindOneOptions<E>,  'select' | 'relations'> & { dto: new () => T };
type FindManyDto<E, T> = Omit<FindManyOptions<E>, 'select' | 'relations'> & { dto: new () => T };
type FindPageDto<E, T> = Omit<FindManyOptions<E>, 'select' | 'relations' | 'skip' | 'take'>
                       & { dto: new () => T; pagination: PaginationParamsDto };

/**
 * TypeORM Repository wrapper with DTO awareness.
 * Derives SELECT and relations from the DTO and maps results via class-transformer.
 *
 * Usage:
 *   private readonly repo: DtoRepository<User>;
 *   constructor(@InjectRepository(User) rawRepo: Repository<User>) {
 *       this.repo = new DtoRepository(rawRepo);
 *   }
 *   const user = await this.repo.findOne({ dto: UserDto, where: { id } });
 */
export class DtoRepository<E extends ObjectLiteral> {
    constructor(private readonly inner: Repository<E>) {}

    async findOne<T>({ dto, ...options }: FindOneDto<E, T>): Promise<T | null> {
        const { select, relations } = buildFindOptions(dto);
        const result = await this.inner.findOne({ ...options, select, relations });
        if (!result) return null;
        // excludeExtraneousValues ensures fields without @Expose() (e.g. password) are stripped.
        return plainToInstance(dto, result, { excludeExtraneousValues: true });
    }

    async find<T>({ dto, ...options }: FindManyDto<E, T>): Promise<T[]> {
        const { select, relations } = buildFindOptions(dto);
        const results = await this.inner.find({ ...options, select, relations });
        return plainToInstance(dto, results, { excludeExtraneousValues: true });
    }

    async findAndCount<T>({ dto, ...options }: FindManyDto<E, T>): Promise<[T[], number]> {
        const { select, relations } = buildFindOptions(dto);
        const [results, total] = await this.inner.findAndCount({ ...options, select, relations });
        return [plainToInstance(dto, results, { excludeExtraneousValues: true }), total];
    }

    async findPaginated<T>({ dto, pagination, ...options }: FindPageDto<E, T>): Promise<PaginationResponseDto<T>> {
        const page  = Number(pagination.page);
        const limit = Number(pagination.limit);
        const { select, relations } = buildFindOptions(dto);

        const [results, total] = await this.inner.findAndCount({
            ...options,
            select,
            relations,
            skip: (page - 1) * limit,
            take: limit,
        });

        return {
            data: plainToInstance(dto, results, { excludeExtraneousValues: true }),
            meta: {
                page,
                limit,
                total: Number(total),
                pages: Math.ceil(Number(total) / limit),
            },
        };
    }
}
