import { Controller, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../shared/decorators/current-user.decorator.js';
import { ParseIdPipe } from '../../shared/pipes/index.js';
import { ApiBadRequests, ApiConflict, ApiForbidden, ApiIdParam, ApiNotFound, ApiUnauthorized } from '../../shared/utils/swagger/index.js';
import { DriverOnly } from '../auth/decorators/index.js';
import { DispatchOtpService } from './dispatch-otp.service.js';

export class DispatchOtpSentDto {
    @ApiProperty({ example: true, description: 'The simulated sender accepted the message.' })
    sent: boolean;
    @ApiProperty({ example: '2026-10-18T12:00:00.000Z', description: 'UTC expiry of the new code.' })
    expiresAt: string;
}

@ApiTags('Dispatches')
@ApiBearerAuth('access-token')
@Controller('dispatches')
export class DispatchOtpController {
    constructor(private readonly otp: DispatchOtpService) {}

    @Post(':id/otp/resend')
    @HttpCode(200)
    @DriverOnly()
    @ApiIdParam('Dispatch')
    @ApiOperation({ summary: 'Resend the delivery OTP', description: 'Only the assigned driver can request up to two resends for an in-transit high-value dispatch. Each replaces the old code and restarts expiry without resetting the three-failure limit. The customer phone is verified by the source system. A missing usable phone requires Dispatch intervention. No code is returned or logged.' })
    @ApiOkResponse({ type: DispatchOtpSentDto })
    @ApiResponse({ status: 503, description: 'OTP_UNAVAILABLE (Redis down) or OTP_SEND_FAILED (bounded resend permitted).' })
    @ApiBadRequests({ id: true })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'Dispatch is not assigned to your route.' })
    @ApiNotFound({ code: 'DISPATCH_NOT_FOUND', message: 'Dispatch not found.' })
    @ApiConflict({ code: 'OTP_ALREADY_ISSUED', message: 'Another request issued the OTP; use its message or retry a controlled resend.' }, { code: 'OTP_RESEND_LIMIT', message: 'OTP cannot be issued in its current state.' }, { code: 'OTP_LOCKED', message: 'OTP cannot be issued in its current state.' }, { code: 'OTP_CONTACT_REQUIRED', message: 'Dispatch must resolve the verified customer phone.' }, { code: 'OTP_NOT_APPLICABLE', message: 'OTP requires an in-transit high-value dispatch.' }, { code: 'OTP_CONSUMED', message: 'OTP cannot be issued in its current state.' }, { code: 'OTP_NOT_ISSUED', message: 'OTP cannot be issued in its current state.' })
    async resend(@Param('id', ParseIdPipe) id: number, @CurrentUser('id') driverId: number): Promise<DispatchOtpSentDto> {
        return await this.otp.resend(id, driverId);
    }
}
