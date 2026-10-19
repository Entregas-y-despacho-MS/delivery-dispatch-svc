import { Body, Controller, Param, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { DriverOnly } from '../auth/decorators/index.js';
import { CurrentUser } from '../../shared/decorators/current-user.decorator.js';
import { ParseIdPipe } from '../../shared/pipes/index.js';
import { ApiBadRequests, ApiConflict, ApiForbidden, ApiIdParam, ApiNotFound, ApiUnauthorized, ApiUnprocessableEntity } from '../../shared/utils/swagger/index.js';
import { CreateDispatchIncidentDto } from './dto/create-dispatch-incident.dto.js';
import { DispatchIncidentResponseDto } from './dto/dispatch-incident-response.dto.js';
import { DispatchIncidentsAppService } from './dispatch-incidents.service.js';
import { SETTINGS_VERSION_HEADER } from '../../modules/settings/settings.constants.js';
import { SettingsService } from '../../modules/settings/services/settings.service.js';

@ApiTags('Dispatches')
@ApiBearerAuth('access-token')
@Controller('dispatches')
export class DispatchIncidentsController {
    constructor(private readonly incidents: DispatchIncidentsAppService, private readonly settings: SettingsService) {}

    @Post(':id/incidents')
    @DriverOnly()
    @ApiIdParam('Dispatch')
    @ApiOperation({
        summary: 'Report an operational incident for a dispatch',
        description: 'The assigned driver reports an incident for an in-transit dispatch. The incident, status transition and history entry are committed together. `incidentId` makes retries idempotent: a new report returns 201, a replay returns the original resource with 200, and neither a replay nor a failed transaction sends another alert. Reasons requiring evidence need a previously uploaded photo for this dispatch, except INC-COMP-FAILURE. The control tower receives a high-criticality alert in the dispatch zone.',
    })
    @ApiCreatedResponse({ type: DispatchIncidentResponseDto, description: 'The incident was recorded and the dispatch moved to incident.', headers: { [SETTINGS_VERSION_HEADER]: { description: 'Current operational settings version. Reload settings when this value changes.', schema: { type: 'integer' } } } })
    @ApiOkResponse({ type: DispatchIncidentResponseDto, description: 'This incidentId was already recorded for the dispatch; the original result is returned.', headers: { [SETTINGS_VERSION_HEADER]: { description: 'Current operational settings version. Reload settings when this value changes.', schema: { type: 'integer' } } } })
    @ApiBadRequests({ validation: true, id: true, errors: [{ code: 'INCIDENT_OBSERVATIONS_TOO_SHORT', message: 'Observations for the catalog reason Otro must contain at least 10 characters.' }, { code: 'INCIDENT_CAPTURE_TIME_INVALID', message: 'occurredAt must be within the last 30 days and no more than 1 hour in the future.' }], example: ['incidentId must be a UUID v7', 'lat must not be greater than 90'] })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'Dispatch is not assigned to your route.' })
    @ApiNotFound({ code: 'DISPATCH_NOT_FOUND', message: 'Dispatch not found.' }, { code: 'INCIDENT_REASON_NOT_FOUND', message: 'Incident reason not found or inactive.' })
    @ApiConflict(
        { code: 'INCIDENT_ID_CONFLICT', message: 'This incidentId belongs to another dispatch or was reused with different data.' },
        { code: 'DISPATCH_NOT_IN_TRANSIT', message: 'An incident can only be reported for an in-transit dispatch.' },
    )
    @ApiUnprocessableEntity({ code: 'INCIDENT_EVIDENCE_REQUIRED', message: 'A photo already registered for this dispatch is required for this incident reason.' })
    async report(
        @Param('id', ParseIdPipe) dispatchId: number,
        @CurrentUser('id') driverId: number,
        @Body() dto: CreateDispatchIncidentDto,
        @Res({ passthrough: true }) response: Response,
    ): Promise<DispatchIncidentResponseDto> {
        const result = await this.incidents.report(dispatchId, driverId, dto);
        response.status(result.created ? 201 : 200);
        response.setHeader(SETTINGS_VERSION_HEADER, String(await this.settings.getVersion()));
        return result.incident;
    }
}
