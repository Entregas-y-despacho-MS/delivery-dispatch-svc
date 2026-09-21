import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import { User } from '../entities/user.entity.js';
import { PasswordHistory } from '../entities/password-history.entity.js';
import { UserDto } from '../dto/user.dto.js';
import { CreateUserDto } from '../dto/create-user.dto.js';
import { UpdateUserDto } from '../dto/update-user.dto.js';
import { FindAllUsersParamsDto } from '../dto/find-all-users-params.dto.js';
import {
    UserNotFoundException, UserAlreadyExistsException, PasswordTooShortException,
    PasswordRecentlyUsedException,
} from '../exceptions/index.js';
import { DtoRepository } from '../../../shared/orm/index.js';
import { PaginationResponseDto } from '../../../shared/dto/index.js';
import { FindOptions, MutationOptions } from '../../../shared/dto/options.dto.js';
import { hashPassword, comparePassword } from '../../../shared/utils/crypto.util.js';
import { SettingsService } from '../../settings/services/settings.service.js';

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
        private readonly settings: SettingsService,
    ) {
        this.repo = new DtoRepository(rawRepo);
    }

    // ── Queries ───────────────────────────────────────────────────────────────

    async findAll<T>(dto: new () => T, params: FindAllUsersParamsDto): Promise<PaginationResponseDto<T>> {
        return this.repo.findPaginated({
            dto,
            pagination: params,
            where: {
                ...(params.roleId !== undefined && { roleId: params.roleId }),
                ...(params.active !== undefined && { active: params.active }),
            },
            order: { createdAt: 'DESC' },
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

    private async _findOne<T>(dto: new () => T, where: FindOptionsWhere<User>, throwException: boolean): Promise<T | null> {
        const result = await this.repo.findOne({ dto, where });
        if (!result && throwException) throw new UserNotFoundException();
        return result;
    }
}
