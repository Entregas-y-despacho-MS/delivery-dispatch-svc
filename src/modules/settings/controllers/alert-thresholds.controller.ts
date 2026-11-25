import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AlertThresholdsService } from '../services/alert-thresholds.service.js';
import { AlertThresholdsDto } from '../dto/alert-thresholds.dto.js';
import { UpdateAlertThresholdsDto } from '../dto/update-alert-thresholds.dto.js';
import { Roles, SupervisorOnly } from '../../../app/auth/decorators/index.js';
import { RoleEnum } from '../../../shared/enums/index.js';
import { ApiBadRequests, ApiNotFound, ApiUnauthorized } from '../../../shared/utils/swagger/index.js';
import { AuditAction } from '../../audit/admin-audit-events/decorators/audit-action.decorator.js';
import { annotateAudit } from '../../audit/admin-audit-events/domain/audit-annotation.js';
import { ALERT_THRESHOLD_KEYS } from '../settings.constants.js';

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
    @AuditAction('setting.updated', {
        entityIdParam: null,
        bodyFields: ['slaAlertMinOnTimePct', 'gpsStaleAlertMinutes', 'driverIncidentAlertPerDay'],
        metadata: { setting: 'alert-thresholds' },
    })
    @SupervisorOnly()
    @ApiOperation({
        summary:     'Change the alert thresholds',
        description: 'Saves the three alert thresholds together: either all are stored or none. The next alert evaluation uses the new values. Successful updates increment the settings version and refresh the shared cache. Requires supervisor role or root.',
    })
    @ApiBadRequests({ validation: true, example: ['slaAlertMinOnTimePct must not be greater than 100'], errors: [{ code: 'INVALID_SETTING_VALUE', message: 'gps_stale_alert_minutes must be a whole number of minutes from 1 to 1440.' }] })
    @ApiOkResponse({ type: AlertThresholdsDto })
    @ApiNotFound({ code: 'SETTING_NOT_FOUND', message: 'Setting not found.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async update(@Body() dto: UpdateAlertThresholdsDto, @Req() request: Request): Promise<AlertThresholdsDto> {
        const { thresholds, version, previous } = await this.thresholds.updateWithChange(dto);
        // ES-68: besides the new values (bodyFields), the event says which version the change produced and what it replaced.
        annotateAudit(request, {
            settingsVersion: version,
            ...Object.fromEntries(Object.entries(ALERT_THRESHOLD_KEYS).map(([field, key]) => [`previous${field[0]!.toUpperCase()}${field.slice(1)}`, /^\d+$/.test(previous[key] ?? '') ? Number(previous[key]) : previous[key]])),
        });
        return thresholds;
    }
}
