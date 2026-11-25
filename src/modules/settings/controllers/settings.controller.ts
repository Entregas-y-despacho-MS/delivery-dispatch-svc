import { Body, Controller, Get, Param, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { SettingsService } from '../services/settings.service.js';
import { SettingDto } from '../dto/setting.dto.js';
import { UpdateSettingDto } from '../dto/update-setting.dto.js';
import { SettingManagedSeparatelyException } from '../exceptions/index.js';
import { ALERT_THRESHOLD_KEYS } from '../settings.constants.js';
import { canWriteSetting } from '../utils/setting-permissions.js';
import { Roles } from '../../../app/auth/decorators/index.js';
import { InsufficientPermissionsException } from '../../../app/auth/exceptions/index.js';
import { CurrentUser } from '../../../shared/decorators/current-user.decorator.js';
import { RoleEnum } from '../../../shared/enums/index.js';
import { ApiForbidden, ApiNotFound, ApiUnauthorized, ApiBadRequests } from '../../../shared/utils/swagger/index.js';
import { AuditAction } from '../../audit/admin-audit-events/decorators/audit-action.decorator.js';
import { annotateAudit } from '../../audit/admin-audit-events/domain/audit-annotation.js';

/**
 * Error dictionary: INVALID_SETTING_VALUE 400, SETTING_NOT_FOUND 404
 *   INVALID_TOKEN 401, INSUFFICIENT_PERMISSIONS 403 (role does not own the key), SETTING_MANAGED_SEPARATELY 403
 */
@ApiTags('Settings')
@ApiBearerAuth('access-token')
@Controller('settings')
export class SettingsController {
    constructor(private readonly settingsService: SettingsService) {}

    @Get()
    @Roles(RoleEnum.ADMIN, RoleEnum.COORDINATOR)
    @ApiOperation({
        summary:     'List settings',
        description: 'Returns each configurable operational setting with its key, current text value and description. Requires admin or coordinator role, or root.',
    })
    @ApiOkResponse({ type: [SettingDto] })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async findAll(): Promise<SettingDto[]> {
        return await this.settingsService.findAll(SettingDto);
    }

    @Put(':key')
    @AuditAction('setting.updated', { entityIdParam: 'key', bodyFields: ['value'] })
    @Roles(RoleEnum.ADMIN, RoleEnum.COORDINATOR)
    @ApiOperation({
        summary:     'Update a setting',
        description: 'Changes the value of an operational setting. Values are sent as text; integer, boolean ("true"/"false"), time, list and cross-setting rules are validated before the update is saved. Successful updates increment the settings version and refresh the shared cache. The password policy (password_min_length, password_expiration_days, password_require_uppercase, password_require_lowercase, password_require_number, password_require_symbol) is changed only by the admin; every other setting only by the coordinator; an admin or coordinator asking for a key of the other role gets 403 INSUFFICIENT_PERMISSIONS and nothing is saved. That check comes first, so it also applies to a key that does not exist (the other role gets 403, not 404) and an admin asking for an alert threshold gets 403 INSUFFICIENT_PERMISSIONS. For the coordinator and root, the three alert thresholds (sla_alert_min_on_time_pct, gps_stale_alert_minutes, driver_incident_alert_per_day) cannot be changed here: 403 SETTING_MANAGED_SEPARATELY, use PUT /settings/alert-thresholds (supervisor). Root can change any key through this endpoint except those three.',
    })
    @ApiParam({ name: 'key', example: 'max_failed_login_attempts', description: 'Key of the setting, as listed by GET /settings' })
    @ApiBadRequests({ validation: true, example: ['value must be a string'], errors: [{ code: 'INVALID_SETTING_VALUE', message: 'max_failed_login_attempts must be a whole number of attempts from 1 to 100.' }] })
    @ApiOkResponse({ type: SettingDto })
    @ApiNotFound({ code: 'SETTING_NOT_FOUND', message: 'Setting not found.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden(
        { code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' },
        { code: 'SETTING_MANAGED_SEPARATELY', message: 'This setting is changed only through PUT /settings/alert-thresholds.' },
    )
    async update(@Param('key') key: string, @Body() dto: UpdateSettingDto, @CurrentUser('role') role: RoleEnum, @Req() request: Request): Promise<SettingDto> {
        // The key decides the role (RF-A10/A20/A25): the guard only knows the endpoint, not the setting.
        if (!canWriteSetting(key, role)) throw new InsufficientPermissionsException();
        // The alert thresholds belong to the supervisor and are saved together: only PUT /settings/alert-thresholds.
        if ((Object.values(ALERT_THRESHOLD_KEYS) as string[]).includes(key)) {
            throw new SettingManagedSeparatelyException('PUT /settings/alert-thresholds');
        }
        const { settings: [updated], version, previous } = await this.settingsService.applyUpdates(SettingDto, { [key]: dto.value });
        // ES-68: the event also says which version the change produced and the value it replaced.
        annotateAudit(request, { settingsVersion: version, previousValue: previous[key] });
        return updated;
    }
}
