import { Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiExtraModels, ApiOperation, ApiTags, getSchemaPath } from '@nestjs/swagger';
import { TrackingService } from '../services/tracking.service.js';
import { ReportLocationsDto } from '../dto/report-locations.dto.js';
import { LocationsReportResultDto } from '../dto/location-report-result.dto.js';
import { DriverOnly } from '../../auth/decorators/index.js';
import { CurrentUser } from '../../../shared/decorators/current-user.decorator.js';
import { ApiUnauthorized, ApiBadRequests } from '../../../shared/utils/swagger/index.js';

/**
 * RF-U11 — telemetría GPS del repartidor en segundo plano. Ningún error de un punto puntual (un
 * despacho que no es suyo, un reloj de dispositivo mal puesto) aborta el resto del lote: cada uno
 * reporta su propio resultado, igual que /sync/events.
 *
 * Error dictionary: ninguno a nivel HTTP del batch — todo se reporta por punto en `results`
 * (`failed` con su `error`) | INVALID_TOKEN 401 | INSUFFICIENT_PERMISSIONS 403.
 */
@ApiTags('Tracking')
@ApiBearerAuth('access-token')
@Controller('tracking')
export class TrackingController {
    constructor(private readonly trackingService: TrackingService) {}

    @Post('locations')
    @DriverOnly()
    @ApiOperation({
        summary:     'Report one or more GPS points captured while a route was active',
        description: 'Used by the driver\'s mobile app to report its position in the background (RF-U11). Send one point per call while online, or several at once after regaining signal (RF-U11, Escenario 3) — order in the request does not matter, they are applied oldest-first by their own `recordedAt`. The HTTP status is 201 even when some points fail: read `results`, where each point reports `applied` (saved and pushed live to the dispatch board), `stale` (an equal-or-newer point already won, nothing to do) or `failed` (with an `error`, e.g. dispatch not found or someone else\'s). A driver can only report on a dispatch of a route assigned to them: any other dispatch id (unknown or someone else\'s) is reported as `failed` with "Dispatch not found.". Requires driver role.',
    })
    @ApiBadRequests({ validation: true, example: ['locations must contain at least 1 elements'] })
    @ApiExtraModels(LocationsReportResultDto)
    @ApiCreatedResponse({
        description: 'The batch was processed. Read each result: 201 does not mean every point was saved.',
        content: { 'application/json': { schema: { $ref: getSchemaPath(LocationsReportResultDto) }, examples: {
            mixed: {
                summary: 'One saved and pushed live, one superseded by a newer point in the same batch, one failed',
                value: { results: [
                    { dispatchId: 42, outcome: 'applied' },
                    { dispatchId: 42, outcome: 'stale' },
                    { dispatchId: 99, outcome: 'failed', error: 'Dispatch not found.' },
                ] },
            },
        } } },
    })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async reportLocations(@Body() dto: ReportLocationsDto, @CurrentUser('id') driverId: number): Promise<LocationsReportResultDto> {
        return await this.trackingService.reportLocations(dto.locations, driverId);
    }
}
