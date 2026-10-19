import { Body, Controller, Param, Patch, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../../../shared/decorators/current-user.decorator.js';
import { ParseIdPipe } from '../../../shared/pipes/index.js';
import { ApiBadRequests, ApiConflict, ApiForbidden, ApiNotFound, ApiUnauthorized } from '../../../shared/utils/swagger/index.js';
import { DriverOnly } from '../../auth/decorators/index.js';
import { DispatchStatusResponseDto } from '../dto/dispatch-status-response.dto.js';
import { UpdateDispatchStatusDto } from '../dto/update-dispatch-status.dto.js';
import { DispatchStatusService } from '../services/dispatch-status.service.js';
import { SETTINGS_VERSION_HEADER } from '../../../modules/settings/settings.constants.js';
import { SettingsService } from '../../../modules/settings/services/settings.service.js';

@ApiTags('Dispatches')
@ApiBearerAuth('access-token')
@Controller('dispatches')
export class DispatchStatusController {
    constructor(private readonly statusService: DispatchStatusService, private readonly settings: SettingsService) {}

    @Patch(':id/status')
    @DriverOnly()
    @ApiParam({ name: 'id', type: Number, description: 'Numeric dispatch identifier.' })
    @ApiOperation({
        summary: 'Update a dispatch status from the driver app',
        description: 'The single-item status endpoint for mobile transitions. Accepts status by name, a UUID v7 eventId for safe offline retries, occurredAt in UTC and GPS coordinates. Only the driver assigned to the route can update it. `out_for_delivery` is set by the separate route-start flow (ST-51.5); incident registration uses POST /dispatches/:id/incidents. Marking a dispatch delivered requires the evidence type selected by its evidence policy to have already been registered.',
    })
    @ApiOkResponse({ type: DispatchStatusResponseDto, description: 'Status updated, or this eventId was already processed.', headers: { [SETTINGS_VERSION_HEADER]: { description: 'Current operational settings version. Reload settings when this value changes.', schema: { type: 'integer' } } } })
    @ApiBadRequests({ validation: true, id: true, example: ['eventId must be a UUID v 7'] })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'Dispatch is not assigned to your route.' })
    @ApiNotFound({ code: 'DISPATCH_NOT_FOUND', message: 'Dispatch not found.' })
    @ApiConflict(
        { code: 'DISPATCH_STATUS_TRANSITION_NOT_ALLOWED', message: 'The dispatch cannot move from assigned to delivered.' },
        { code: 'DISPATCH_STATUS_EVENT_OUT_OF_ORDER', message: 'This event is older than the last recorded status change.' },
        { code: 'DISPATCH_STATUS_TERMINAL', message: 'The dispatch is already delivered and cannot change status.' },
        { code: 'ANOTHER_DISPATCH_IN_TRANSIT', message: 'Another dispatch on this route is already in transit.' },
        { code: 'ROUTE_BATCH_NOT_IN_EXECUTION', message: 'The route batch must be in execution before a driver can change a dispatch status.' },
        { code: 'EVENT_ID_ALREADY_USED', message: 'This eventId was already used for another event.' },
        { code: 'DISPATCH_STATUS_EVENT_TIME_INVALID', message: 'occurredAt is in the future or more than 30 days old.' },
        { code: 'DISPATCH_STATUS_UNKNOWN', message: 'The requested status is not configured.' },
    )
    @ApiResponse({ status: 422, description: 'The evidence required by the dispatch policy has not been registered.', schema: { example: { statusCode: 422, error: 'DISPATCH_EVIDENCE_REQUIRED', message: 'The delivery requires signature evidence before it can be marked delivered.' } } })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async updateStatus(
        @Param('id', ParseIdPipe) dispatchId: number,
        @Body() dto: UpdateDispatchStatusDto,
        @CurrentUser('id') driverId: number,
        @Res({ passthrough: true }) response: Response,
    ): Promise<DispatchStatusResponseDto> {
        const result = await this.statusService.update(dispatchId, dto, driverId);
        response.setHeader(SETTINGS_VERSION_HEADER, String(await this.settings.getVersion()));
        return result;
    }
}
