import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { SettingsService } from '../services/settings.service.js';
import { SettingDto } from '../dto/setting.dto.js';
import { UpdateSettingDto } from '../dto/update-setting.dto.js';
import { SettingManagedSeparatelyException } from '../exceptions/index.js';
import { ALERT_THRESHOLD_KEYS } from '../settings.constants.js';
import { CoordinatorOnly, Roles } from '../../../app/auth/decorators/index.js';
import { RoleEnum } from '../../../shared/enums/index.js';
import { ApiNotFound, ApiUnauthorized, ApiBadRequests } from '../../../shared/utils/swagger/index.js';

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
    @CoordinatorOnly()
    @ApiOperation({
        summary:     'Update a setting',
        description: 'Changes the value of an operational setting. Values are sent as text; integer, time, list and cross-setting rules are validated before the update is saved. Successful updates increment the settings version and refresh the shared cache. The three alert thresholds (sla_alert_min_on_time_pct, gps_stale_alert_minutes, driver_incident_alert_per_day) cannot be changed here: 403 SETTING_MANAGED_SEPARATELY, use PUT /settings/alert-thresholds. Requires coordinator role or root.',
    })
    @ApiParam({ name: 'key', example: 'max_failed_login_attempts', description: 'Key of the setting, as listed by GET /settings' })
    @ApiBadRequests({ validation: true, example: ['value must be a string'], errors: [{ code: 'INVALID_SETTING_VALUE', message: 'max_failed_login_attempts must be a whole number of attempts from 1 to 100.' }] })
    @ApiOkResponse({ type: SettingDto })
    @ApiNotFound({ code: 'SETTING_NOT_FOUND', message: 'Setting not found.' })    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async update(@Param('key') key: string, @Body() dto: UpdateSettingDto): Promise<SettingDto> {
        // The alert thresholds belong to the supervisor and are saved together: only PUT /settings/alert-thresholds.
        if ((Object.values(ALERT_THRESHOLD_KEYS) as string[]).includes(key)) {
            throw new SettingManagedSeparatelyException('PUT /settings/alert-thresholds');
        }
        return await this.settingsService.update(SettingDto, key, dto.value);
    }
}
