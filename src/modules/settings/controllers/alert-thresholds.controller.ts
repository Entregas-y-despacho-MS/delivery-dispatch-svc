import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AlertThresholdsService } from '../services/alert-thresholds.service.js';
import { AlertThresholdsDto } from '../dto/alert-thresholds.dto.js';
import { UpdateAlertThresholdsDto } from '../dto/update-alert-thresholds.dto.js';
import { Roles, SupervisorOnly } from '../../../app/auth/decorators/index.js';
import { RoleEnum } from '../../../shared/enums/index.js';
import { ApiBadRequests, ApiNotFound, ApiUnauthorized } from '../../../shared/utils/swagger/index.js';

/**
 * Error dictionary: INVALID_SETTING_VALUE 400, SETTING_NOT_FOUND 404
 *   INVALID_TOKEN 401, INSUFFICIENT_PERMISSIONS 403
 *
 * Registered before SettingsController: its `PUT /settings/:key` would otherwise take `alert-thresholds` as a key.
 */
@ApiTags('Settings')
@ApiBearerAuth('access-token')
@Controller('settings/alert-thresholds')
export class AlertThresholdsController {
    constructor(private readonly thresholds: AlertThresholdsService) {}

    @Get()
    @Roles(RoleEnum.SUPERVISOR, RoleEnum.COORDINATOR)
    @ApiOperation({
        summary:     'Get the alert thresholds',
        description: 'Returns the three thresholds that trigger the automatic performance alerts: minimum on-time delivery percentage, minutes without GPS signal and incidents per driver per day. Requires supervisor or coordinator role, or root.',
    })
    @ApiOkResponse({ type: AlertThresholdsDto })
    @ApiNotFound({ code: 'SETTING_NOT_FOUND', message: 'Setting not found.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async get(): Promise<AlertThresholdsDto> {
        return await this.thresholds.get();
    }

    @Put()
    @SupervisorOnly()
    @ApiOperation({
        summary:     'Change the alert thresholds',
        description: 'Saves the three alert thresholds together: either all are stored or none. The next alert evaluation uses the new values. Successful updates increment the settings version and refresh the shared cache. Requires supervisor role or root.',
    })
    @ApiBadRequests({ validation: true, example: ['slaAlertMinOnTimePct must not be greater than 100'], errors: [{ code: 'INVALID_SETTING_VALUE', message: 'gps_stale_alert_minutes must be a whole number of minutes from 1 to 1440.' }] })
    @ApiOkResponse({ type: AlertThresholdsDto })
    @ApiNotFound({ code: 'SETTING_NOT_FOUND', message: 'Setting not found.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async update(@Body() dto: UpdateAlertThresholdsDto): Promise<AlertThresholdsDto> {
        return await this.thresholds.update(dto);
    }
}
