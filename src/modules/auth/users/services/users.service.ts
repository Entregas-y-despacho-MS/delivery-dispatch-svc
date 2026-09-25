import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsOrder, FindOptionsWhere, ILike, IsNull, LessThanOrEqual, MoreThan, Repository } from 'typeorm';
import { User } from '../entities/user.entity.js';
import { PasswordHistory } from '../entities/password-history.entity.js';
import { Role } from '../../roles/entities/role.entity.js';
import { UserDto } from '../dto/user.dto.js';
import { CreateUserDto } from '../dto/create-user.dto.js';
import { UpdateUserDto } from '../dto/update-user.dto.js';
import { FindAllUsersParamsDto, UserSortBy } from '../dto/find-all-users-params.dto.js';
import {
    UserNotFoundException, UserAlreadyExistsException, PasswordTooShortException,
    PasswordRecentlyUsedException, ConflictingUserFiltersException, InvalidRoleException,
} from '../exceptions/index.js';
import { DtoRepository } from '../../../../shared/orm/index.js';
import { PaginationResponseDto } from '../../../../shared/dto/index.js';
import { FindOptions, MutationOptions } from '../../../../shared/dto/options.dto.js';
import { hashPassword, comparePassword } from '../../../../shared/utils/crypto.util.js';
import { escapeLike } from '../../../../shared/utils/like.util.js';
import { UserStatusEnum } from '../../../../shared/enums/index.js';
import { SettingsService } from '../../../settings/services/settings.service.js';

// How many previous passwords are checked for reuse (RF-A25, Escenario 3).
const PASSWORD_HISTORY_SIZE = 3;

@Injectable()
export class UsersService {
    private readonly repo: DtoRepository<User>;

    constructor(
        @InjectRepository(User)
        private readonly rawRepo: Repository<User>,
        @InjectRepository(PasswordHistory)
        private readonly historyRepo: Repository<PasswordHistory>,
        @InjectRepository(Role)
        private readonly roleRepo: Repository<Role>,
        private readonly settings: SettingsService,
    ) {
        this.repo = new DtoRepository(rawRepo);
    }

    // ── Queries ───────────────────────────────────────────────────────────────

    /**
     * RF-A28 — server-side pagination + combinable filters (role, status, text search) + sorting.
     * Every filter narrows the result ("and"); only the text search matches across several columns.
     */
    async findAll<T>(dto: new () => T, params: FindAllUsersParamsDto): Promise<PaginationResponseDto<T>> {
        // `?active=` (empty) is converted to null by the DTO: it means "no filter", so it is neither
        // combined with `status` nor turned into `active IS NULL` (which made the query fail).
        const hasActive = params.active !== undefined && params.active !== null;

        // `active` (raw column) and `status` (derived) overlap — combining them is ambiguous.
        if (hasActive && params.status !== undefined) throw new ConflictingUserFiltersException();

        const where = this.buildListWhere(params, new Date());
        return this.repo.findPaginated({
            dto,
            pagination: params,
            where:      where.length === 1 ? where[0] : where,
            order:      this.buildListOrder(params),
        });
    }

    /**
     * Generic base — looks up a user matching any entity attribute combination.
     * Pass the DTO class to control which fields are selected and returned.
     */
    findOne<T>(dto: new () => T, where: FindOptionsWhere<User>, options: { throwException: false }): Promise<T | null>;
    findOne<T>(dto: new () => T, where: FindOptionsWhere<User>, options?: FindOptions): Promise<T>;
    async findOne<T>(dto: new () => T, where: FindOptionsWhere<User>, { throwException = true }: FindOptions = {}): Promise<T | null> {
        return this._findOne(dto, where, throwException);
    }

    findOneById<T>(dto: new () => T, id: number, options: { throwException: false }): Promise<T | null>;
    findOneById<T>(dto: new () => T, id: number, options?: FindOptions): Promise<T>;
    async findOneById<T>(dto: new () => T, id: number, { throwException = true }: FindOptions = {}): Promise<T | null> {
        return this._findOne(dto, { id }, throwException);
    }

    findOneByUsername<T>(dto: new () => T, username: string, options: { throwException: false }): Promise<T | null>;
    findOneByUsername<T>(dto: new () => T, username: string, options?: FindOptions): Promise<T>;
    async findOneByUsername<T>(dto: new () => T, username: string, { throwException = true }: FindOptions = {}): Promise<T | null> {
        return this._findOne(dto, { username }, throwException);
    }

    findOneByEmail<T>(dto: new () => T, email: string, options: { throwException: false }): Promise<T | null>;
    findOneByEmail<T>(dto: new () => T, email: string, options?: FindOptions): Promise<T>;
    async findOneByEmail<T>(dto: new () => T, email: string, { throwException = true }: FindOptions = {}): Promise<T | null> {
        return this._findOne(dto, { email }, throwException);
    }

    findOneByResetToken<T>(dto: new () => T, token: string, options: { throwException: false }): Promise<T | null>;
    findOneByResetToken<T>(dto: new () => T, token: string, options?: FindOptions): Promise<T>;
    async findOneByResetToken<T>(dto: new () => T, token: string, { throwException = true }: FindOptions = {}): Promise<T | null> {
        return this._findOne(dto, { passwordResetToken: token }, throwException);
    }

    // ── Mutations ─────────────────────────────────────────────────────────────

    /** Persists the hashed refresh token. Pass null to close the session (logout / revocation). */
    async setRefreshToken(userId: number, hashedToken: string | null): Promise<void> {
        await this.rawRepo.update(userId, { refreshTokenHash: hashedToken });
    }

    /**
     * Sets a new password hash for a self-service change (own change or reset-by-token).
     * Rejects reuse of the current password or the last PASSWORD_HISTORY_SIZE ones (RF-A25,
     * Escenario 3), records the outgoing hash into history, and resets passwordChangedAt (RF-A25,
     * Escenario 2) plus requiresPwdChange/lockout/reset state.
     */
    async updatePassword(userId: number, plainPassword: string): Promise<void> {
        this.validatePasswordPolicy(plainPassword);

        const current = await this.rawRepo.findOneByOrFail({ id: userId });
        await this.assertPasswordNotReused(current, plainPassword);

        await this.historyRepo.save(this.historyRepo.create({ userId, passwordHash: current.passwordHash }));

        await this.rawRepo.update(userId, {
            passwordHash:            await hashPassword(plainPassword),
            passwordChangedAt:       new Date(),
            requiresPwdChange:       false,
            failedAttempts:          0,
            lockedUntil:             null,
            passwordResetToken:      null,
            passwordResetExpiresAt:  null,
        });
    }

    async setLockoutState(userId: number, failedAttempts: number, lockedUntil: Date | null): Promise<void> {
        await this.rawRepo.update(userId, { failedAttempts, lockedUntil });
    }

    /** RF-A28 — called on every successful login (not on token refresh). */
    async setLastLogin(userId: number): Promise<void> {
        await this.rawRepo.update(userId, { lastLoginAt: new Date() });
    }

    async setPasswordResetToken(userId: number, token: string, expiresAt: Date): Promise<void> {
        await this.rawRepo.update(userId, { passwordResetToken: token, passwordResetExpiresAt: expiresAt });
    }

    async setTwoFactorSecret(userId: number, secret: string): Promise<void> {
        await this.rawRepo.update(userId, { twoFactorSecret: secret });
    }

    async setTwoFactorEnabled(userId: number, enabled: boolean): Promise<void> {
        await this.rawRepo.update(userId, { twoFactorEnabled: enabled, ...(!enabled && { twoFactorSecret: null }) });
    }

    async create<T>(returnDto: new () => T, dto: CreateUserDto, options?: MutationOptions): Promise<T> {
        const repo = options?.manager?.getRepository(User) ?? this.rawRepo;

        if (await this.existsByUsernameOrEmail(dto.username, dto.email)) throw new UserAlreadyExistsException();
        this.validatePasswordPolicy(dto.password);
        await this.assertRoleExists(dto.roleId, options);

        const user        = repo.create();
        user.fullName      = dto.fullName;
        user.username      = dto.username;
        user.email         = dto.email ?? null;
        user.passwordHash  = await hashPassword(dto.password);
        user.roleId        = dto.roleId;

        const saved = await repo.save(user);

        // Build DtoRepository from the same repo so the result is visible within any active transaction.
        const result = await new DtoRepository(repo).findOne({ dto: returnDto, where: { id: saved.id } });
        return result!;
    }

    /**
     * Admin-driven update (PUT /users/:id). If dto.password is set, resets passwordChangedAt too
     * (RF-A25, Escenario 2) — but does NOT check password history: an admin resetting someone's
     * password (e.g. account recovery) is a different operational case from a user's own
     * self-service change, and shouldn't be blocked by that user's history.
     */
    async update<T>(returnDto: new () => T, id: number, dto: UpdateUserDto, options?: MutationOptions): Promise<T> {
        const repo = options?.manager?.getRepository(User) ?? this.rawRepo;

        const current = await this.findOneById(UserDto, id);

        const usernameChanged = dto.username !== undefined && dto.username !== current.username;
        const emailChanged    = dto.email    !== undefined && dto.email    !== current.email;
        if (usernameChanged || emailChanged) {
            if (await this.existsByUsernameOrEmail(usernameChanged ? dto.username : undefined, emailChanged ? dto.email : undefined, id)) {
                throw new UserAlreadyExistsException();
            }
        }

        if (dto.password !== undefined) this.validatePasswordPolicy(dto.password);
        if (dto.roleId   !== undefined) await this.assertRoleExists(dto.roleId, options);

        const payload: Record<string, any> = {};
        if (dto.fullName !== undefined) payload.fullName     = dto.fullName;
        if (dto.username !== undefined) payload.username     = dto.username;
        if (dto.email    !== undefined) payload.email        = dto.email;
        if (dto.roleId   !== undefined) payload.roleId       = dto.roleId;
        if (dto.active   !== undefined) payload.active       = dto.active;
        if (dto.password !== undefined) {
            payload.passwordHash      = await hashPassword(dto.password);
            payload.passwordChangedAt = new Date();
        }

        await repo.update(id, payload);

        const result = await new DtoRepository(repo).findOne({ dto: returnDto, where: { id } });
        return result!;
    }

    async remove(id: number, options?: MutationOptions): Promise<void> {
        const repo = options?.manager?.getRepository(User) ?? this.rawRepo;
        await this.findOneById(UserDto, id);
        if (options?.hardDelete) {
            await repo.delete(id);
        } else {
            await repo.softDelete(id);
        }
    }

    // ── Private implementation ────────────────────────────────────────────────

    /** An unknown roleId would otherwise reach the FK and come back as a 500. */
    private async assertRoleExists(roleId: number, options?: MutationOptions): Promise<void> {
        const repo = options?.manager?.getRepository(Role) ?? this.roleRepo;
        if (!(await repo.existsBy({ id: roleId }))) throw new InvalidRoleException();
    }

    /** Backed by settings.password_min_length — every code path that sets a password goes through here. */
    private validatePasswordPolicy(plainPassword: string): void {
        const minLength = this.settings.getNumber('password_min_length', 6);
        if (plainPassword.length < minLength) throw new PasswordTooShortException(minLength);
    }

    /** RF-A25, Escenario 3 — rejects the current password and the last PASSWORD_HISTORY_SIZE ones. */
    private async assertPasswordNotReused(user: User, plainPassword: string): Promise<void> {
        if (await comparePassword(plainPassword, user.passwordHash)) throw new PasswordRecentlyUsedException();

        const recent = await this.historyRepo.find({
            where: { userId: user.id },
            order: { createdAt: 'DESC' },
            take:  PASSWORD_HISTORY_SIZE,
        });
        for (const entry of recent) {
            if (await comparePassword(plainPassword, entry.passwordHash)) throw new PasswordRecentlyUsedException();
        }
    }

    private async existsByUsernameOrEmail(username?: string, email?: string, excludeId?: number): Promise<boolean> {
        if (username && await this.existsBy({ username }, excludeId)) return true;
        if (email && await this.existsBy({ email }, excludeId)) return true;
        return false;
    }

    private async existsBy(where: FindOptionsWhere<User>, excludeId?: number): Promise<boolean> {
        const found = await this.rawRepo.findOne({ where, withDeleted: true });
        return !!found && found.id !== excludeId;
    }

    /**
     * TypeORM expresses OR as an array of where-objects, so a filter that needs an OR (the text
     * search over 3 columns, the "active" status = no lock OR expired lock) multiplies the branches:
     * every existing branch is combined with every alternative. At most 2 x 3 = 6 branches.
     */
    private buildListWhere(params: FindAllUsersParamsDto, now: Date): FindOptionsWhere<User>[] {
        let branches: FindOptionsWhere<User>[] = [{
            ...(params.roleId !== undefined && { roleId: params.roleId }),
            ...(params.active !== undefined && params.active !== null && { active: params.active }),
        }];
        const and = (alternatives: FindOptionsWhere<User>[]) => {
            branches = branches.flatMap((branch) => alternatives.map((alt) => ({ ...branch, ...alt })));
        };

        switch (params.status) {
            case UserStatusEnum.INACTIVE: and([{ active: false }]); break;
            case UserStatusEnum.LOCKED:   and([{ active: true, lockedUntil: MoreThan(now) }]); break;
            case UserStatusEnum.ACTIVE:
                and([{ active: true, lockedUntil: IsNull() }, { active: true, lockedUntil: LessThanOrEqual(now) }]);
                break;
        }

        const search = params.search?.trim();
        if (search) {
            const pattern = `%${escapeLike(search)}%`;
            and([{ fullName: ILike(pattern) }, { username: ILike(pattern) }, { email: ILike(pattern) }]);
        }
        return branches;
    }

    /** Default: newest first. `id` breaks ties so a page boundary never repeats or skips a row. */
    private buildListOrder(params: FindAllUsersParamsDto): FindOptionsOrder<User> {
        const sortBy    = params.sortBy ?? UserSortBy.CREATED_AT;
        const direction = (params.sortOrder ?? 'desc').toUpperCase() as 'ASC' | 'DESC';
        // Users who never logged in have no date: keep them last in either direction.
        const primary = sortBy === UserSortBy.LAST_LOGIN_AT ? { direction, nulls: 'LAST' as const } : direction;
        return { [sortBy]: primary, id: 'ASC' };
    }

    private async _findOne<T>(dto: new () => T, where: FindOptionsWhere<User>, throwException: boolean): Promise<T | null> {
        const result = await this.repo.findOne({ dto, where });
        if (!result && throwException) throw new UserNotFoundException();
        return result;
    }
}
