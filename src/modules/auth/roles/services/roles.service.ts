import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { And, Equal, FindOperator, FindOptionsOrder, FindOptionsWhere, ILike, Not, Repository } from 'typeorm';
import { escapeLike } from '../../../../shared/utils/like.util.js';
import { Role } from '../entities/role.entity.js';
import { RoleDto } from '../dto/role.dto.js';
import { RoleDetailDto } from '../dto/role-detail.dto.js';
import { FindAllRolesParamsDto, RoleSortBy } from '../dto/find-all-roles-params.dto.js';
import { RoleNotFoundException } from '../exceptions/index.js';
import { DtoRepository } from '../../../../shared/orm/index.js';
import { PaginationResponseDto } from '../../../../shared/dto/index.js';
import { FindOptions } from '../../../../shared/dto/options.dto.js';
import { RoleEnum } from '../../../../shared/enums/index.js';
import { UsersService } from '../../users/services/users.service.js';

// Read-only — roles are a fixed catalog (root/admin/coordinator/supervisor/driver) seeded by
// roles.data.sql, not administrable via the API. See RoleEnum + .claude/rules/auth.md.
@Injectable()
export class RolesService {
    private readonly repo: DtoRepository<Role>;

    constructor(
        @InjectRepository(Role)
        private readonly rawRepo: Repository<Role>,
        private readonly usersService: UsersService,
    ) {
        this.repo = new DtoRepository(rawRepo);
    }

    /**
     * Filters combine with "and": `search` (name contains), `name` (exact) and `assignable` (only what
     * `actorRole` may give to a user: never `root` unless the actor is root). Sorted by `sortBy`, then by id.
     */
    async findAll<T>(dto: new () => T, params: FindAllRolesParamsDto, actorRole?: RoleEnum): Promise<PaginationResponseDto<T>> {
        // Every condition is on `name`, so they are ANDed into one operator on that column.
        const conditions: FindOperator<string>[] = [];
        const search = params.search?.trim();
        if (search) conditions.push(ILike(`%${escapeLike(search)}%`));
        if (params.name !== undefined) conditions.push(Equal(params.name));
        if (params.assignable === true && actorRole !== RoleEnum.ROOT) conditions.push(Not(RoleEnum.ROOT));

        const where: FindOptionsWhere<Role> = conditions.length === 0 ? {} : { name: conditions.length === 1 ? conditions[0] : And(...conditions) };
        return this.repo.findPaginated({ dto, pagination: params, where, order: this.buildOrder(params) });
    }

    /** The listing as GET /roles serves it: each role with its user counts. */
    async findAllWithUserCounts(params: FindAllRolesParamsDto, actorRole?: RoleEnum): Promise<PaginationResponseDto<RoleDetailDto>> {
        const page = await this.findAll(RoleDto, params, actorRole);
        return { ...page, data: await this.withUserCounts(page.data) };
    }

    async findOneByIdWithUserCounts(id: number): Promise<RoleDetailDto> {
        const role = await this.findOneById(RoleDto, id);
        return (await this.withUserCounts([role]))[0];
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

    // ── Private implementation ────────────────────────────────────────────────

    private buildOrder(params: FindAllRolesParamsDto): FindOptionsOrder<Role> {
        const direction = (params.sortOrder ?? 'asc').toUpperCase() as 'ASC' | 'DESC';
        const field = params.sortBy ?? RoleSortBy.ID;
        // Every sort ends in id, so a page never repeats or skips rows when the field ties.
        return field === RoleSortBy.ID ? { id: direction } : { [field]: direction, id: 'ASC' };
    }

    private async withUserCounts(roles: RoleDto[]): Promise<RoleDetailDto[]> {
        const counts = await this.usersService.countByRoles(roles.map((role) => role.id));
        return roles.map((role) => Object.assign(new RoleDetailDto(), role, {
            userCount:       counts.get(role.id)?.total  ?? 0,
            activeUserCount: counts.get(role.id)?.active ?? 0,
        }));
    }

    private async _findOne<T>(dto: new () => T, where: FindOptionsWhere<Role>, throwException: boolean): Promise<T | null> {
        const role = await this.repo.findOne({ dto, where });
        if (!role && throwException) throw new RoleNotFoundException();
        return role;
    }
}
