import { Controller, Patch, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import {
    ApiTags, ApiOperation,
    ApiOkResponse, ApiCreatedResponse, ApiNoContentResponse,
} from '@nestjs/swagger';
import { AuthService } from '../services/auth.service.js';
import { UserDto } from '../../../modules/users/dto/user.dto.js';
import { CreateUserDto } from '../../../modules/users/dto/create-user.dto.js';
import { LoginDto } from '../dto/login.dto.js';
import { RefreshDto } from '../dto/refresh.dto.js';
import { ChangePasswordDto } from '../dto/change-password.dto.js';
import { ForgotPasswordDto } from '../dto/forgot-password.dto.js';
import { ResetPasswordDto } from '../dto/reset-password.dto.js';
import { AuthResponseDto } from '../dto/auth-response.dto.js';
import { Public, AdminOnly } from '../decorators/index.js';
import { CurrentUser } from '../../../shared/decorators/current-user.decorator.js';
import type { AuthUser } from '../strategies/jwt.strategy.js';
import { ApiValidationError, ApiUnauthorized, ApiConflict } from '../../../shared/utils/swagger/index.js';

/**
 * Error dictionary for this module:
 *   INVALID_CREDENTIALS      401 — Username/current password not found or does not match.
 *   INVALID_REFRESH_TOKEN    401 — Refresh token is expired, malformed, or was already used (reuse detection).
 *   INVALID_TOKEN            401 — Access JWT is missing, malformed, or expired (guard — applies to protected routes).
 *   ACCOUNT_LOCKED           401 — Too many failed login attempts, temporarily locked.
 *   TOTP_REQUIRED            401 — Account has 2FA enabled, login needs a totpCode.
 *   INVALID_TOTP_CODE        401 — The 6-digit code does not match.
 *   INVALID_RESET_TOKEN      401 — Password reset token is invalid, expired, or already used.
 *   SESSION_EXPIRED          401 — Refresh attempted after too long without activity (RF-A24, does not apply to the driver mobile app).
 *   USER_ALREADY_EXISTS      409 — A user with the given username or email already exists.
 *   INSUFFICIENT_PERMISSIONS 403 — Authenticated but role does not meet the endpoint requirement.
 *
 * Internal, admin-managed system — register is not public, only an admin (or root) can create accounts.
 */
@ApiTags('Auth')
@Controller('auth')
export class AuthController {
    constructor(private readonly authService: AuthService) {}

    @Public()
    @Post('login')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary:     'Login',
        description: 'Validates username and password (plus totpCode if 2FA is enabled). Returns an access token (short-lived) and a refresh token (long-lived). The generic 401 message intentionally hides whether the username exists.',
    })
    @ApiOkResponse({ type: AuthResponseDto })
    @ApiValidationError()
    @ApiUnauthorized(
        { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials.' },
        { code: 'ACCOUNT_LOCKED',      message: 'Account is temporarily locked due to too many failed login attempts.' },
        { code: 'TOTP_REQUIRED',       message: 'A TOTP code is required to complete login.' },
        { code: 'INVALID_TOTP_CODE',   message: 'Invalid TOTP code.' },
    )
    async login(@Body() dto: LoginDto): Promise<AuthResponseDto> {
        return await this.authService.login(dto);
    }

    @AdminOnly()
    @Post('register')
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({
        summary:     'Register a new internal user',
        description: 'Creates a new internal account (coordinator/supervisor/driver/admin). Admin-only — this is not public self-registration. Returns the created user, not a token pair (the caller is the admin, not the new user).',
    })
    @ApiCreatedResponse({ type: UserDto })
    @ApiValidationError()
    @ApiConflict({ code: 'USER_ALREADY_EXISTS', message: 'A user with this username or email already exists.' })
    async register(@Body() dto: CreateUserDto): Promise<UserDto> {
        return await this.authService.register(dto);
    }

    @Public()
    @Post('refresh')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary:     'Refresh tokens',
        description: 'Issues a new access + refresh token pair from the current refresh token. The previous refresh token is immediately invalidated (rotation). If a token is used twice, all sessions are revoked. Also enforces RF-A24 (auto session close on inactivity) — not for the driver role, whose mobile app relies on long-lived sessions while on a route.',
    })
    @ApiOkResponse({ type: AuthResponseDto })
    @ApiValidationError()
    @ApiUnauthorized(
        { code: 'INVALID_REFRESH_TOKEN', message: 'Invalid or expired refresh token.' },
        { code: 'SESSION_EXPIRED',       message: 'Session closed due to inactivity. Please log in again.' },
    )
    async refresh(@Body() dto: RefreshDto): Promise<AuthResponseDto> {
        return await this.authService.refresh(dto);
    }

    // No @Roles() — any authenticated user can log out regardless of role (JwtAuthGuard already
    // requires a valid token; RolesGuard allows through when no role list is set).
    @Post('logout')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({
        summary:     'Logout',
        description: 'Invalidates the refresh token stored in the database. The current access token remains valid until its natural expiry — clients should discard it locally.',
    })
    @ApiNoContentResponse({ description: 'Logged out successfully.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async logout(@CurrentUser() user: AuthUser): Promise<void> {
        return await this.authService.logout(user.id);
    }

    // No @Roles() — any authenticated user changes their own password.
    @Patch('change-password')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({
        summary:     'Change own password',
        description: 'Requires the current password. On success, revokes the current session — the client must log in again.',
    })
    @ApiNoContentResponse({ description: 'Password changed.' })
    @ApiValidationError()
    @ApiUnauthorized(
        { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials.' },
        { code: 'INVALID_TOKEN',       message: 'Invalid or expired token.' },
    )
    async changePassword(@CurrentUser('id') userId: number, @Body() dto: ChangePasswordDto): Promise<void> {
        return await this.authService.changePassword(userId, dto);
    }

    @Public()
    @Post('forgot-password')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({
        summary:     'Request a password reset',
        description: 'Sends a reset token by email if the address belongs to an active account. Always responds the same way, whether the email exists or not — never reveals which.',
    })
    @ApiNoContentResponse({ description: 'Request accepted.' })
    @ApiValidationError()
    async forgotPassword(@Body() dto: ForgotPasswordDto): Promise<void> {
        return await this.authService.forgotPassword(dto);
    }

    @Public()
    @Post('reset-password')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({
        summary:     'Reset password with a token',
        description: 'Completes the flow started by POST /auth/forgot-password. The token is single-use and expires after 30 minutes.',
    })
    @ApiNoContentResponse({ description: 'Password reset.' })
    @ApiValidationError()
    @ApiUnauthorized({ code: 'INVALID_RESET_TOKEN', message: 'Invalid or expired password reset token.' })
    async resetPassword(@Body() dto: ResetPasswordDto): Promise<void> {
        return await this.authService.resetPassword(dto);
    }
}
