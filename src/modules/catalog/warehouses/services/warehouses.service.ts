import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, ILike, Repository } from 'typeorm';
import { Warehouse } from '../entities/warehouse.entity.js';
import { FindAllWarehousesParamsDto } from '../dto/find-all-warehouses-params.dto.js';
import { WarehouseNotFoundException } from '../exceptions/index.js';
import { DtoRepository } from '../../../../shared/orm/index.js';
import { PaginationResponseDto } from '../../../../shared/dto/index.js';
import { FindOptions } from '../../../../shared/dto/options.dto.js';
import { escapeLike } from '../../../../shared/utils/like.util.js';

// Corrección de ES-26/ST-26.1 — catálogo de solo lectura: ni create, ni update, ni remove. Se
// siembra directo en la DB (ver delivery-dispatch-db), no vía API.
@Injectable()
export class WarehousesService {
    private readonly repo: DtoRepository<Warehouse>;

    constructor(
        @InjectRepository(Warehouse)
        private readonly rawRepo: Repository<Warehouse>,
    ) {
        this.repo = new DtoRepository(rawRepo);
    }

    async findAll<T>(dto: new () => T, params: FindAllWarehousesParamsDto): Promise<PaginationResponseDto<T>> {
        const base: FindOptionsWhere<Warehouse> = {
            ...(params.active !== undefined && params.active !== null && { active: params.active }),
        };
        // Repeats the base filter in every OR branch, or the search would bypass `active`.
        const search = params.search?.trim();
        const where: FindOptionsWhere<Warehouse> | FindOptionsWhere<Warehouse>[] = search
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

    findOneById<T>(dto: new () => T, id: number, options: { throwException: false }): Promise<T | null>;
    findOneById<T>(dto: new () => T, id: number, options?: FindOptions): Promise<T>;
    async findOneById<T>(dto: new () => T, id: number, { throwException = true }: FindOptions = {}): Promise<T | null> {
        const result = await this.repo.findOne({ dto, where: { id } });
        if (!result && throwException) throw new WarehouseNotFoundException();
        return result;
    }
}
