import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SettingsService } from '../services/settings.service.js';
import { SettingDto } from '../dto/setting.dto.js';
import { UpdateSettingDto } from '../dto/update-setting.dto.js';
import { AdminOnly } from '../../../app/auth/decorators/index.js';
import { ApiNotFound, ApiUnauthorized, ApiValidationError } from '../../../shared/utils/swagger/index.js';

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
        description: 'Returns every business-config key/value. Requires admin role or root.',
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
        description: 'Updates a setting\'s value. Requires admin role or root. Takes effect immediately.',
    })
    @ApiOkResponse({ type: SettingDto })
    @ApiValidationError()
    @ApiNotFound({ code: 'SETTING_NOT_FOUND', message: 'Setting not found.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async update(@Param('key') key: string, @Body() dto: UpdateSettingDto): Promise<SettingDto> {
        return await this.settingsService.update(SettingDto, key, dto.value);
    }
}
