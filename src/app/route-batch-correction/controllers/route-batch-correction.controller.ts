import { Body, Controller, Param, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../auth/decorators/index.js';
import { AssignRouteBatchDriverDto } from '../../../modules/dispatch/route-batches/dto/assign-route-batch-driver.dto.js';
import { AssignRouteBatchVehicleDto } from '../../../modules/dispatch/route-batches/dto/assign-route-batch-vehicle.dto.js';
import { CurrentUser } from '../../../shared/decorators/current-user.decorator.js';
import { RoleEnum } from '../../../shared/enums/index.js';
import { ParseIdPipe } from '../../../shared/pipes/index.js';
import {
    ApiBadRequests,
    ApiConflict,
    ApiForbidden,
    ApiIdParam,
    ApiNotFound,
    ApiUnauthorized,
    ApiUnprocessableEntity,
    errorBody,
} from '../../../shared/utils/swagger/index.js';
import { RouteBatchCorrectionResultDto } from '../dto/route-batch-correction-result.dto.js';
import { RouteBatchCorrectionService } from '../services/route-batch-correction.service.js';

const OSRM_UNAVAILABLE = errorBody(
    503,
    'OSRM_UNAVAILABLE',
    'The routing engine (OSRM) did not answer within 5 s. Try again in a few minutes.',
);

/**
 * ST-50.1 — vehicle capacity validation; ST-51.6 — correction of the driver and the vehicle of a batch.
 *
 * Error dictionary: VALIDATION_FAILED 400 | INVALID_TOKEN 401 | INSUFFICIENT_PERMISSIONS 403 |
 * ROUTE_BATCH_NOT_FOUND 404 | VEHICLE_NOT_FOUND 404 | ROUTE_BATCH_NOT_CORRECTABLE 409 |
 * ROUTE_BATCH_VERSION_CONFLICT 409 | ROUTE_CAPACITY_EXCEEDED 409 | ROUTE_BATCH_VEHICLE_NOT_ACTIVE 409 |
 * ROUTE_BATCH_RESOURCE_CONFLICT 409 | ROUTE_BATCH_DRIVER_NOT_AVAILABLE 409 |
 * PLANNING_SETTINGS_MISSING 422 | OSRM_UNAVAILABLE 503.
 */
@ApiTags('Route batches')
@ApiBearerAuth('access-token')
@Controller('route-batches')
export class RouteBatchCorrectionController {
    constructor(private readonly correction: RouteBatchCorrectionService) {}

    @Patch(':id/driver')
    @Roles(RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR)
    @ApiOperation({
        summary: 'Assign or change the proposed driver of a route batch',
        description:
            'Sets `proposed_driver_id` of a `provisional` or `pending_final_review` batch, which is how a batch the generator left without driver (or a driver that fell through) is fixed before the 2nd approval. The driver must be active, have the driver role and have no other live batch that day. Send the `version` you reviewed: a different current version answers 409. A real change raises the `version` by one and writes a `driver_changed` event (actor, previous and new driver). In `pending_final_review` the batch is then validated again with the rules of the D-1 cutoff (capacity, vehicle, driver, promised slots): if it passes it stays in review (`cutoff_validated`); if it fails it goes back to `provisional` with the reasons (`cutoff_failed`, also shown by `GET /route-batches/:id`), keeps the correction, and the next cutoff run or `POST /planning/cutoff` takes it again. The answer is 200 in both cases: read `status` and `validation`. Sending the driver the batch already has changes nothing. A `confirmed` or later batch answers 409. Requires coordinator or supervisor role, or root.',
    })
    @ApiIdParam('Route batch')
    @ApiOkResponse({ type: RouteBatchCorrectionResultDto })
    @ApiBadRequests({ validation: true, id: true, example: ['driverId must be an integer number.', 'version must not be less than 0.'] })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' })
    @ApiNotFound({ code: 'ROUTE_BATCH_NOT_FOUND', message: 'Route batch not found.' })
    @ApiConflict(
        { code: 'ROUTE_BATCH_NOT_CORRECTABLE', message: 'The driver or the vehicle can only be corrected while the route batch is provisional or pending final review (current status: confirmed).' },
        { code: 'ROUTE_BATCH_VERSION_CONFLICT', message: 'The route batch (or one of its orders) changed. Reload it before correcting.' },
        { code: 'ROUTE_BATCH_DRIVER_NOT_AVAILABLE', message: 'The driver is inactive, is not a driver, or is already assigned or proposed for another batch that day.' },
    )
    @ApiUnprocessableEntity({ code: 'PLANNING_SETTINGS_MISSING', message: 'The batch cannot be validated until the planning settings are fixed (missing: stop_service_minutes, planning_margin_pct). Set them with PUT /settings/:key.' })
    @ApiServiceUnavailableResponse({
        description: 'OSRM did not answer in time (`OSRM_UNAVAILABLE`); only a batch pending final review needs it. Nothing was written.',
        schema: { example: OSRM_UNAVAILABLE },
    })
    async changeDriver(
        @Param('id', ParseIdPipe) id: number,
        @Body() dto: AssignRouteBatchDriverDto,
        @CurrentUser('id') actorUserId: number,
    ): Promise<RouteBatchCorrectionResultDto> {
        return await this.correction.changeDriver(id, dto.driverId, dto.version, actorUserId);
    }

    @Patch(':id/vehicle')
    @Roles(RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR)
    @ApiOperation({
        summary: 'Assign or change the vehicle of a route batch after validating capacity',
        description:
            'Assigns a vehicle to a `provisional` or `pending_final_review` batch only when it is active, nobody else uses it that day, and total package weight and volume fit its capacity and every per-package dimension limit is met (dispatches without package records use their estimated weight, marked as estimated in the returned report). Send the `version` you reviewed: a different current version answers 409. A real change raises the `version` by one and writes a `vehicle_changed` event (actor, previous and new vehicle). In `pending_final_review` the batch is then validated again with the rules of the D-1 cutoff: if it passes it stays in review (`cutoff_validated`); if it fails it goes back to `provisional` with the reasons (`cutoff_failed`), keeps the correction, and the next cutoff run or `POST /planning/cutoff` takes it again. The answer is 200 in both cases: read `status` and `validation`. Sending the vehicle the batch already has changes nothing. A `confirmed` or later batch answers 409. Requires coordinator or supervisor role, or root.',
    })
    @ApiIdParam('Route batch')
    @ApiOkResponse({ type: RouteBatchCorrectionResultDto })
    @ApiBadRequests({ validation: true, id: true, example: ['vehicleId must be an integer number.', 'version must not be less than 0.'] })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' })
    @ApiNotFound(
        { code: 'ROUTE_BATCH_NOT_FOUND', message: 'Route batch not found.' },
        { code: 'VEHICLE_NOT_FOUND', message: 'Vehicle not found.' },
    )
    @ApiConflict(
        { code: 'ROUTE_BATCH_NOT_CORRECTABLE', message: 'The driver or the vehicle can only be corrected while the route batch is provisional or pending final review (current status: confirmed).' },
        { code: 'ROUTE_BATCH_VERSION_CONFLICT', message: 'The route batch (or one of its orders) changed. Reload it before correcting.' },
        { code: 'ROUTE_CAPACITY_EXCEEDED', message: 'The route exceeds the selected vehicle capacity or package dimensions.' },
        { code: 'ROUTE_BATCH_VEHICLE_NOT_ACTIVE', message: 'The vehicle is not active.' },
        { code: 'ROUTE_BATCH_RESOURCE_CONFLICT', message: 'The vehicle is already assigned to another batch that day.' },
    )
    @ApiUnprocessableEntity({ code: 'PLANNING_SETTINGS_MISSING', message: 'The batch cannot be validated until the planning settings are fixed (missing: stop_service_minutes, planning_margin_pct). Set them with PUT /settings/:key.' })
    @ApiServiceUnavailableResponse({
        description: 'OSRM did not answer in time (`OSRM_UNAVAILABLE`); only a batch pending final review needs it. Nothing was written.',
        schema: { example: OSRM_UNAVAILABLE },
    })
    async changeVehicle(
        @Param('id', ParseIdPipe) id: number,
        @Body() dto: AssignRouteBatchVehicleDto,
        @CurrentUser('id') actorUserId: number,
    ): Promise<RouteBatchCorrectionResultDto> {
        return await this.correction.changeVehicle(id, dto.vehicleId, dto.version, actorUserId);
    }
}
