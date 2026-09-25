import { Controller, Patch, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import {
    ApiTags, ApiOperation, ApiBearerAuth,
    ApiOkResponse, ApiCreatedResponse, ApiNoContentResponse,
} from '@nestjs/swagger';
import { AuthService } from '../services/auth.service.js';
import { UserDto } from '../../../modules/auth/users/dto/user.dto.js';
import { CreateUserDto } from '../../../modules/auth/users/dto/create-user.dto.js';
import { LoginDto } from '../dto/login.dto.js';
import { RefreshDto } from '../dto/refresh.dto.js';
import { ChangePasswordDto } from '../dto/change-password.dto.js';
import { ForgotPasswordDto } from '../dto/forgot-password.dto.js';
import { ResetPasswordDto } from '../dto/reset-password.dto.js';
import { AuthResponseDto } from '../dto/auth-response.dto.js';
import { Public, AdminOnly } from '../decorators/index.js';
import { CurrentUser } from '../../../shared/decorators/current-user.decorator.js';
import type { AuthUser } from '../strategies/jwt.strategy.js';
import { ApiUnauthorized, ApiConflict, ApiBadRequests } from '../../../shared/utils/swagger/index.js';

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
 *   PASSWORD_TOO_SHORT       400 — New password is shorter than settings.password_min_length.
 *   PASSWORD_RECENTLY_USED   400 — New password matches the current one or one of the last 3 (RF-A25).
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
        description: 'Exchanges a `username` and `password` for an access token (short-lived, sent as `Authorization: Bearer <token>`) and a refresh token (long-lived, used only in POST /auth/refresh). If the account has 2FA enabled, `totpCode` is also required (401 TOTP_REQUIRED without it). Check `mustChangePassword` in the response: when true the client must send the user to change their password before anything else. Repeated wrong passwords lock the account for a while (401 ACCOUNT_LOCKED). A wrong username, wrong password or deactivated account all return the same INVALID_CREDENTIALS, so it never reveals which accounts exist. Public.',
    })
    @ApiBadRequests({ validation: true, example: ['Username is required.'] })
    @ApiOkResponse({ type: AuthResponseDto })
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
    @ApiBearerAuth('access-token')
    @Post('register')
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({
        summary:     'Register a new internal user',
        description: 'Creates an internal account. Same body and rules as POST /users (admin-only, not a public sign-up). Returns the created user, not tokens: the caller is the admin, not the new user. Requires admin role or root.',
    })
    @ApiBadRequests({ validation: true, example: ['Full name is required.', 'Role ID must be an integer.'], errors: [{ code: 'PASSWORD_TOO_SHORT', message: 'Password must be at least 8 characters.' }, { code: 'INVALID_ROLE', message: 'The given role does not exist.' }] })
    @ApiCreatedResponse({ type: UserDto })
    @ApiConflict({ code: 'USER_ALREADY_EXISTS', message: 'A user with this username or email already exists.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async register(@Body() dto: CreateUserDto): Promise<UserDto> {
        return await this.authService.register(dto);
    }

    @Public()
    @Post('refresh')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary:     'Refresh tokens',
        description: 'Exchanges a valid refresh token for a new access + refresh pair. The old refresh token stops working immediately (rotation); presenting an already-used one closes every session of that user (401 INVALID_REFRESH_TOKEN). A session that stayed inactive longer than the configured limit is closed (401 SESSION_EXPIRED), except for the driver role, whose mobile app keeps long sessions while on a route. Public: authenticated by the refresh token in the body.',
    })
    @ApiBadRequests({ validation: true, example: ['Refresh token is required.'] })
    @ApiOkResponse({ type: AuthResponseDto })
    @ApiUnauthorized(
        { code: 'INVALID_REFRESH_TOKEN', message: 'Invalid or expired refresh token.' },
        { code: 'SESSION_EXPIRED',       message: 'Session closed due to inactivity. Please log in again.' },
    )
    async refresh(@Body() dto: RefreshDto): Promise<AuthResponseDto> {
        return await this.authService.refresh(dto);
    }

    // No @Roles() — any authenticated user can log out regardless of role (JwtAuthGuard already
    // requires a valid token; RolesGuard allows through when no role list is set).
    @ApiBearerAuth('access-token')
    @Post('logout')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({
        summary:     'Logout',
        description: 'Revokes the user\'s refresh token, so the session cannot be renewed. The current access token stays valid until it expires: the client must discard it. Requires any authenticated user.',
    })
    @ApiNoContentResponse({ description: 'Logged out successfully.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async logout(@CurrentUser() user: AuthUser): Promise<void> {
        return await this.authService.logout(user.id);
    }

    // No @Roles() — any authenticated user changes their own password.
    @ApiBearerAuth('access-token')
    @Patch('change-password')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({
        summary:     'Change own password',
        description: 'Changes the password of the logged-in user. Requires the current password (401 INVALID_CREDENTIALS if wrong). The new password must be at least 8 characters with an uppercase letter, a lowercase letter, a number and a symbol, meet the configured minimum length (400 PASSWORD_TOO_SHORT), and differ from the current one and the last 3 used (400 PASSWORD_RECENTLY_USED). On success the session is revoked: the client must log in again with the new password. Requires any authenticated user.',
    })
    @ApiBadRequests({ validation: true, example: ['New password is required.'], errors: [{ code: 'PASSWORD_TOO_SHORT',     message: 'Password must be at least 8 characters.' }, { code: 'PASSWORD_RECENTLY_USED', message: 'You cannot reuse your current password or any of your last 3 passwords.' }] })
    @ApiNoContentResponse({ description: 'Password changed.' })
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
        description: 'Starts the password recovery flow: if `email` belongs to an active account, an email with a single-use reset token is sent (valid for a limited time, 30 minutes by default). The response is always 204 whether the email exists or not, so it never reveals which addresses are registered. Public.',
    })
    @ApiBadRequests({ validation: true, example: ['Email must be a valid email address.'] })
    @ApiNoContentResponse({ description: 'Request accepted.' })
    async forgotPassword(@Body() dto: ForgotPasswordDto): Promise<void> {
        return await this.authService.forgotPassword(dto);
    }

    @Public()
    @Post('reset-password')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({
        summary:     'Reset password with a token',
        description: 'Finishes the recovery flow started with POST /auth/forgot-password: sets a new password using the emailed `token`. The token is single-use and expires (401 INVALID_RESET_TOKEN once used or expired). The new password follows the same rules as in change-password. Also clears any account lock and closes the user\'s sessions. Public: authenticated by the token.',
    })
    @ApiBadRequests({ validation: true, example: ['Token is required.'], errors: [{ code: 'PASSWORD_TOO_SHORT',     message: 'Password must be at least 8 characters.' }, { code: 'PASSWORD_RECENTLY_USED', message: 'You cannot reuse your current password or any of your last 3 passwords.' }] })
    @ApiNoContentResponse({ description: 'Password reset.' })
    @ApiUnauthorized({ code: 'INVALID_RESET_TOKEN', message: 'Invalid or expired password reset token.' })
    async resetPassword(@Body() dto: ResetPasswordDto): Promise<void> {
        return await this.authService.resetPassword(dto);
    }
}
