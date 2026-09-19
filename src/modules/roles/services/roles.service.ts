import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, ILike, Repository } from 'typeorm';
import { Role } from '../entities/role.entity.js';
import { FindAllRolesParamsDto } from '../dto/find-all-roles-params.dto.js';
import { RoleNotFoundException } from '../exceptions/index.js';
import { DtoRepository } from '../../../shared/orm/index.js';
import { PaginationResponseDto } from '../../../shared/dto/index.js';
import { FindOptions } from '../../../shared/dto/options.dto.js';

// Read-only — roles are a fixed catalog (root/admin/coordinator/supervisor/driver) seeded by
// roles.data.sql, not administrable via the API. See RoleEnum + .claude/rules/auth.md.
@Injectable()
export class RolesService {
    private readonly repo: DtoRepository<Role>;

    constructor(
        @InjectRepository(Role)
        private readonly rawRepo: Repository<Role>,
    ) {
        this.repo = new DtoRepository(rawRepo);
    }

    async findAll<T>(dto: new () => T, params: FindAllRolesParamsDto): Promise<PaginationResponseDto<T>> {
        return this.repo.findPaginated({
            dto,
            pagination: params,
            where: {
                ...(params.search && { name: ILike(`%${params.search}%`) }),
            },
            order: { id: 'ASC' },
        });
    }

    /**
     * Generic base — looks up a role matching any entity attribute combination.
     * Pass the DTO class to control which fields are selected and returned.
     */
    findOne<T>(dto: new () => T, where: FindOptionsWhere<Role>, options: { throwException: false }): Promise<T | null>;
    findOne<T>(dto: new () => T, where: FindOptionsWhere<Role>, options?: FindOptions): Promise<T>;
    async findOne<T>(dto: new () => T, where: FindOptionsWhere<Role>, { throwException = true }: FindOptions = {}): Promise<T | null> {
        return this._findOne(dto, where, throwException);
    }

    findOneById<T>(dto: new () => T, id: number, options: { throwException: false }): Promise<T | null>;
    findOneById<T>(dto: new () => T, id: number, options?: FindOptions): Promise<T>;
    async findOneById<T>(dto: new () => T, id: number, { throwException = true }: FindOptions = {}): Promise<T | null> {
        return this._findOne(dto, { id }, throwException);
    }

    private async _findOne<T>(dto: new () => T, where: FindOptionsWhere<Role>, throwException: boolean): Promise<T | null> {
        const role = await this.repo.findOne({ dto, where });
        if (!role && throwException) throw new RoleNotFoundException();
        return role;
    }
}
