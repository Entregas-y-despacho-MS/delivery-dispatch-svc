import { Body, Controller, Delete, HttpCode, HttpStatus, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AllowWhilePasswordChangeRequired, DriverOnly } from '../../../../app/auth/decorators/index.js';
import { CurrentUser } from '../../../../shared/decorators/current-user.decorator.js';
import { ApiBadRequests, ApiConflict, ApiForbidden, ApiUnauthorized } from '../../../../shared/utils/swagger/index.js';
import { PushTokenDeviceParamsDto } from '../dto/push-token-device-params.dto.js';
import { RegisterPushTokenDto } from '../dto/register-push-token.dto.js';
import { PushTokensService } from '../services/push-tokens.service.js';

/**
 * RF-U10 — push token of the driver's phone. Always acts on the logged-in user: the owner is never
 * read from the request.
 *
 * Error dictionary: PUSH_TOKEN_IN_USE 409 | INVALID_TOKEN 401 | INSUFFICIENT_PERMISSIONS 403
 */
@ApiTags('Push tokens')
@ApiBearerAuth('access-token')
@Controller('push-tokens')
export class PushTokensController {
    constructor(private readonly service: PushTokensService) {}

    @Put(':deviceId')
    @DriverOnly()
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({
        summary:     'Register the push token of this device',
        description: 'Stores the push token of the logged-in driver\'s device so the backend can notify it when a batch with their route is approved (RF-U10). Idempotent: sending the same device again updates its token and platform instead of creating another row, and reactivates it if it was revoked. Call it after every successful login and whenever the token changes. If another user had the same token active (a shared phone), that registration is revoked first, so notifications never reach the wrong driver. Requires driver role.',
    })
    @ApiBadRequests({ validation: true, example: ['Token must not be empty.', 'Platform must be ios or android.'] })
    @ApiNoContentResponse({ description: 'Token registered.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden()
    @ApiConflict({ code: 'PUSH_TOKEN_IN_USE', message: 'This push token was just registered by another user. Try again.' })
    async register(
        @Param() params: PushTokenDeviceParamsDto,
        @Body() dto: RegisterPushTokenDto,
        @CurrentUser('id') userId: number,
    ): Promise<void> {
        await this.service.register(userId, params.deviceId, dto);
    }

    // Allowed while the password change is pending: the driver must still be able to close the session
    // (POST /auth/logout is allowed then too), and the app revokes the token right before it.
    @Delete(':deviceId')
    @DriverOnly()
    @AllowWhilePasswordChangeRequired()
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({
        summary:     'Revoke the push token of this device',
        description: 'Stops notifications to this device. The app calls it right before POST /auth/logout, so the next driver who uses the phone does not inherit the previous driver\'s notifications. Never fails because of the device state: revoking a token that is already revoked, or a device that was never registered, also answers 204, so a logout is never blocked. Allowed even while the account must change its password. Requires driver role.',
    })
    @ApiBadRequests({ validation: true, example: ['Device ID must be at most 100 characters.'] })
    @ApiNoContentResponse({ description: 'Token revoked (or there was nothing to revoke).' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden()
    async revoke(@Param() params: PushTokenDeviceParamsDto, @CurrentUser('id') userId: number): Promise<void> {
        await this.service.revoke(userId, params.deviceId);
    }
}
