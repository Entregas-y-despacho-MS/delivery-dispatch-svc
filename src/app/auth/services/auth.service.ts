import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../../../modules/users/services/users.service.js';
import { UserDto } from '../../../modules/users/dto/user.dto.js';
import { UserForAuthDto } from '../../../modules/users/dto/user-for-auth.dto.js';
import { JwtConfig } from '../config/jwt.config.js';
import { CreateUserDto } from '../../../modules/users/dto/create-user.dto.js';
import { LoginDto } from '../dto/login.dto.js';
import { RefreshDto } from '../dto/refresh.dto.js';
import { ChangePasswordDto } from '../dto/change-password.dto.js';
import { ForgotPasswordDto } from '../dto/forgot-password.dto.js';
import { ResetPasswordDto } from '../dto/reset-password.dto.js';
import { AuthResponseDto } from '../dto/auth-response.dto.js';
import { JwtPayload } from '../strategies/jwt.strategy.js';
import { TwoFactorService } from './two-factor.service.js';
import { MailerPort } from '../../../plugins/mailer/mailer.port.js';
import { SettingsService } from '../../../modules/settings/services/settings.service.js';
import {
    InvalidCredentialsException, InvalidRefreshTokenException, AccountLockedException,
    InvalidResetTokenException, TotpRequiredException, InvalidTotpCodeException,
    SessionExpiredException,
} from '../exceptions/index.js';
import { comparePassword, hashPassword } from '../../../shared/utils/crypto.util.js';
import { RoleEnum } from '../../../shared/enums/index.js';

@Injectable()
export class AuthService {
    constructor(
        private readonly usersService:   UsersService,
        private readonly jwtService:     JwtService,
        private readonly jwtConfig:      JwtConfig,
        private readonly twoFactor:      TwoFactorService,
        private readonly mailer:         MailerPort,
        private readonly settings:       SettingsService,
    ) {}

    async login(dto: LoginDto): Promise<AuthResponseDto> {
        const user = await this.usersService.findOneByUsername(UserForAuthDto, dto.username, { throwException: false });

        // Same generic error whether the username doesn't exist, the account is inactive,
        // or the password doesn't match — never reveal which case it was.
        if (!user || !user.active) throw new InvalidCredentialsException();

        if (user.lockedUntil && user.lockedUntil > new Date()) throw new AccountLockedException();

        const passwordMatch = await comparePassword(dto.password, user.passwordHash);
        if (!passwordMatch) {
            await this.registerFailedAttempt(user);
            throw new InvalidCredentialsException();
        }

        if (user.twoFactorEnabled) {
            if (!dto.totpCode) throw new TotpRequiredException();
            const codeValid = await this.twoFactor.verify(user.twoFactorSecret!, dto.totpCode);
            if (!codeValid) throw new InvalidTotpCodeException();
        }

        await this.usersService.setLockoutState(user.id, 0, null);

        const payload: JwtPayload = {
            sub:      user.id,
            username: user.username,
            roleId:   user.roleId,
            role:     user.role.name as RoleEnum,
        };
        const { accessToken, refreshToken } = await this.buildTokens(payload);

        const userDto = await this.usersService.findOneById(UserDto, user.id);
        return { accessToken, refreshToken, user: userDto };
    }

    // Admin-only (see AuthController) — creates an internal account. No tokens are returned:
    // the caller is the admin, not the new user, so there is no session to hand back.
    async register(dto: CreateUserDto): Promise<UserDto> {
        return await this.usersService.create(UserDto, dto);
    }

    async refresh(dto: RefreshDto): Promise<AuthResponseDto> {
        let payload: JwtPayload;
        try {
            payload = this.jwtService.verify<JwtPayload>(dto.refreshToken, {
                secret: this.jwtConfig.refreshSecret,
            });
        } catch {
            throw new InvalidRefreshTokenException();
        }

        // RF-A24 — auto session close on inactivity. Exempt: the driver mobile app in route,
        // which persists the session via refresh tokens on purpose (RF-A24's own wording).
        // No DB read needed — a refresh token's own `iat` is effectively "last activity", since
        // tokens rotate on every use.
        if (payload.role !== RoleEnum.DRIVER) {
            const inactivityMinutes = this.settings.getNumber('session_inactivity_minutes', 30);
            const idleMs = Date.now() - payload.iat! * 1000;
            if (idleMs > inactivityMinutes * 60_000) {
                await this.usersService.setRefreshToken(payload.sub, null);
                throw new SessionExpiredException();
            }
        }

        const user = await this.usersService.findOneById(UserForAuthDto, payload.sub, { throwException: false });

        if (!user || !user.active || !user.refreshTokenHash) throw new InvalidRefreshTokenException();

        const tokenMatches = await comparePassword(dto.refreshToken, user.refreshTokenHash);

        if (!tokenMatches) {
            // Hash mismatch may indicate refresh token reuse — revoke all sessions.
            await this.usersService.setRefreshToken(user.id, null);
            throw new InvalidRefreshTokenException();
        }

        const newPayload: JwtPayload = {
            sub:      user.id,
            username: user.username,
            roleId:   user.roleId,
            role:     user.role.name as RoleEnum,
        };
        const { accessToken, refreshToken } = await this.buildTokens(newPayload);

        const userDto = await this.usersService.findOneById(UserDto, user.id);
        return { accessToken, refreshToken, user: userDto };
    }

    async logout(userId: number): Promise<void> {
        await this.usersService.setRefreshToken(userId, null);
    }

    async changePassword(userId: number, dto: ChangePasswordDto): Promise<void> {
        const user = await this.usersService.findOneById(UserForAuthDto, userId);

        const passwordMatch = await comparePassword(dto.currentPassword, user.passwordHash);
        if (!passwordMatch) throw new InvalidCredentialsException();

        await this.usersService.updatePassword(userId, dto.newPassword);
        // Password changed — revoke the current session too, client must log in again.
        await this.usersService.setRefreshToken(userId, null);
    }

    // Always responds the same way whether the email exists or not — never reveal which.
    async forgotPassword(dto: ForgotPasswordDto): Promise<void> {
        const user = await this.usersService.findOneByEmail(UserForAuthDto, dto.email, { throwException: false });
        if (!user || !user.active) return;

        const expiryMinutes = this.settings.getNumber('password_reset_expiry_minutes', 30);
        const token     = randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + expiryMinutes * 60_000);
        await this.usersService.setPasswordResetToken(user.id, token, expiresAt);

        this.mailer.send({
            to:      dto.email,
            subject: 'Recuperación de contraseña',
            html: `
                <p>Recibimos una solicitud para restablecer tu contraseña.</p>
                <p>Usá este código en la pantalla de restablecimiento (válido por ${expiryMinutes} minutos):</p>
                <p style="font-size: 20px; font-weight: bold; letter-spacing: 2px;">${token}</p>
                <p>Si no fuiste vos, podés ignorar este correo.</p>
            `,
        });
    }

    async resetPassword(dto: ResetPasswordDto): Promise<void> {
        const user = await this.usersService.findOneByResetToken(UserForAuthDto, dto.token, { throwException: false });

        const tokenExpired = !user?.passwordResetExpiresAt || user.passwordResetExpiresAt < new Date();
        if (!user || tokenExpired) throw new InvalidResetTokenException();

        await this.usersService.updatePassword(user.id, dto.newPassword);
        await this.usersService.setRefreshToken(user.id, null);
    }

    private async registerFailedAttempt(user: UserForAuthDto): Promise<void> {
        const maxAttempts    = this.settings.getNumber('max_failed_login_attempts', 5);
        const lockoutMinutes = this.settings.getNumber('account_lockout_minutes', 15);

        const failedAttempts = user.failedAttempts + 1;
        const lockedUntil = failedAttempts >= maxAttempts
            ? new Date(Date.now() + lockoutMinutes * 60_000)
            : null;
        await this.usersService.setLockoutState(user.id, failedAttempts, lockedUntil);
    }

    private async buildTokens(payload: JwtPayload): Promise<{ accessToken: string; refreshToken: string }> {
        const accessToken = this.jwtService.sign(payload);

        const refreshToken = this.jwtService.sign(payload, {
            secret:    this.jwtConfig.refreshSecret,
            expiresIn: this.jwtConfig.refreshExpiresIn as any,
        });

        // Never store refresh tokens in plain text — treat them like passwords.
        const hashed = await hashPassword(refreshToken);
        await this.usersService.setRefreshToken(payload.sub, hashed);

        return { accessToken, refreshToken };
    }
}
