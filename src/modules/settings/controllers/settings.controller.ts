import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { SettingsService } from '../services/settings.service.js';
import { SettingDto } from '../dto/setting.dto.js';
import { UpdateSettingDto } from '../dto/update-setting.dto.js';
import { AdminOnly } from '../../../app/auth/decorators/index.js';
import { ApiNotFound, ApiUnauthorized, ApiBadRequests } from '../../../shared/utils/swagger/index.js';

/**
 * Error dictionary for this module:
 *   SETTING_NOT_FOUND     404 — No setting with that key exists.
 *   INVALID_TOKEN         401 — JWT is missing, malformed, or expired.
 *   INSUFFICIENT_PERMISSIONS 403 — Authenticated but role does not meet the endpoint requirement.
 *
 * Business-tunable config (RF-A10/A20/A25) — admin-only. Values are cached in memory
 * (SettingsService) and updated in place on every write, so changes here apply immediately
 * without a restart.
 */
@ApiTags('Settings')
@ApiBearerAuth('access-token')
@Controller('settings')
export class SettingsController {
    constructor(private readonly settingsService: SettingsService) {}

    @Get()
    @AdminOnly()
    @ApiOperation({
        summary:     'List settings',
        description: 'Returns every business-configuration entry (delivery window, password policy, lockout and session rules, OTP, SLA alert threshold). Each has a `key`, a text `value` and a `description` of what it controls. Requires admin role or root.',
    })
    @ApiOkResponse({ type: [SettingDto] })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async findAll(): Promise<SettingDto[]> {
        return await this.settingsService.findAll(SettingDto);
    }

    @Put(':key')
    @AdminOnly()
    @ApiOperation({
        summary:     'Update a setting',
        description: 'Changes the `value` of the setting identified by `key` (see GET /settings for the valid keys; an unknown key is 404 SETTING_NOT_FOUND). Values are always sent as text (e.g. "5", "08:00") and are stored as given, so send one that is valid for that key. The change applies immediately, with no restart. Requires admin role or root.',
    })
    @ApiParam({ name: 'key', example: 'max_failed_login_attempts', description: 'Key of the setting, as listed by GET /settings' })
    @ApiBadRequests({ validation: true })
    @ApiOkResponse({ type: SettingDto })
    @ApiNotFound({ code: 'SETTING_NOT_FOUND', message: 'Setting not found.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async update(@Param('key') key: string, @Body() dto: UpdateSettingDto): Promise<SettingDto> {
        return await this.settingsService.update(SettingDto, key, dto.value);
    }
}
