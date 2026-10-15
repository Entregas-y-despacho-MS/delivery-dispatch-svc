import { Body, Controller, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RouteBatchReviewerService } from '../services/route-batch-reviewer.service.js';
import { UpdateRouteBatchReviewerDto } from '../dto/update-route-batch-reviewer.dto.js';
import { RouteBatchReviewerDto } from '../dto/route-batch-reviewer.dto.js';
import { AssignRouteBatchVehicleDto } from '../dto/assign-route-batch-vehicle.dto.js';
import { RouteBatchVehicleAssignmentDto } from '../dto/route-batch-vehicle-assignment.dto.js';
import { RouteBatchVehicleService } from '../services/route-batch-vehicle.service.js';
import { RouteBatchPromiseApprovalService } from '../services/route-batch-promise-approval.service.js';
import { ApproveRouteBatchPromisesDto } from '../dto/approve-route-batch-promises.dto.js';
import { ApproveRouteBatchPromisesResponseDto } from '../dto/approve-route-batch-promises-response.dto.js';
import { ApproveFinalRouteBatchDto } from '../dto/approve-final-route-batch.dto.js';
import { ApproveFinalRouteBatchResponseDto } from '../dto/approve-final-route-batch-response.dto.js';
import { RouteBatchFinalApprovalService } from '../services/route-batch-final-approval.service.js';
import { Roles } from '../../../../app/auth/decorators/index.js';
import { CurrentUser } from '../../../../shared/decorators/current-user.decorator.js';
import { ParseIdPipe } from '../../../../shared/pipes/index.js';
import { RoleEnum } from '../../../../shared/enums/index.js';
import {
  ApiBadRequests,
  ApiConflict,
  ApiForbidden,
  ApiIdParam,
  ApiNotFound,
  ApiUnauthorized,
} from '../../../../shared/utils/swagger/index.js';

/**
 * ST-50.1 — vehicle capacity validation; ST-50.4 — reviewer of a provisional route batch (D-42).
 *
 * Error dictionary: VALIDATION_FAILED 400 | INVALID_TOKEN 401 | INSUFFICIENT_PERMISSIONS 403 |
 * ROUTE_BATCH_NOT_FOUND 404 | ROUTE_BATCH_NOT_PROVISIONAL 409 | ROUTE_BATCH_REVIEWER_NOT_ELIGIBLE 409.
 */
@ApiTags('Route batches')
@ApiBearerAuth('access-token')
@Controller('route-batches')
export class RouteBatchesController {
  constructor(
    private readonly reviewerService: RouteBatchReviewerService,
    private readonly vehicleService: RouteBatchVehicleService,
    private readonly promiseApprovalService: RouteBatchPromiseApprovalService,
    private readonly finalApprovalService: RouteBatchFinalApprovalService,
  ) {}

  @Post(':id/approve-promises')
  @HttpCode(HttpStatus.OK)
  @Roles(RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR)
  @ApiOperation({
    summary: 'Approve promises in a provisional route batch',
    description: 'Checks expected batch and dispatch versions, reviewer ownership, and committed vehicle capacity in a transaction. Dispatches selected for removal return to pending and are audited. Customer email attempts happen only after the transaction commits. A successful send sets promiseNotifiedAt; a bounce opens a coordinator contact follow-up and is not acceptance. Tracking tokens remain valid while the delivery is open (D-18).',
  })
  @ApiIdParam('Route batch')
  @ApiOkResponse({ type: ApproveRouteBatchPromisesResponseDto })
  @ApiBadRequests({ validation: true, id: true, example: ['version must not be less than 0.'] })
  @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
  @ApiForbidden(
    { code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' },
    { code: 'ROUTE_BATCH_REVIEWER_MISMATCH', message: 'Only the assigned reviewer can approve this provisional batch.' },
  )
  @ApiNotFound({ code: 'ROUTE_BATCH_NOT_FOUND', message: 'Route batch not found.' })
  @ApiConflict(
    { code: 'ROUTE_BATCH_NOT_PROVISIONAL', message: 'Only a provisional route batch can be approved.' },
    { code: 'ROUTE_BATCH_VERSION_CONFLICT', message: 'The route batch changed. Reload it before approving.' },
    { code: 'DISPATCH_VERSION_CONFLICT', message: 'One or more dispatches changed. Reload the route batch.' },
    { code: 'ROUTE_BATCH_VEHICLE_REQUIRED', message: 'Assign a vehicle before approving promises.' },
    { code: 'ROUTE_BATCH_HAS_NO_APPROVALS', message: 'At least one dispatch must remain in the batch.' },
    { code: 'ROUTE_CAPACITY_EXCEEDED', message: 'The route exceeds the selected vehicle capacity or package dimensions.' },
  )
  async approvePromises(
    @Param('id', ParseIdPipe) id: number,
    @Body() dto: ApproveRouteBatchPromisesDto,
    @CurrentUser('id') actorUserId: number,
  ): Promise<ApproveRouteBatchPromisesResponseDto> {
    return await this.promiseApprovalService.approve(id, dto, actorUserId);
  }

  @Post(':id/approve-final')
  @HttpCode(HttpStatus.OK)
  @Roles(RoleEnum.COORDINATOR)
  @ApiOperation({
    summary: 'Approve a validated route batch for final assignment',
    description: 'Atomically confirms a pending-final-review batch, assigns its proposed active driver and active vehicle, and moves every scheduled delivery dispatch to assigned. The request must include the current planning version of the batch and every dispatch. Approval rechecks complete destinations, registered packages, promised windows, vehicle capacity and resource availability. After commit it emits route.assigned for the dispatch board, assigned driver and push-notification listener.',
  })
  @ApiIdParam('Route batch')
  @ApiOkResponse({ type: ApproveFinalRouteBatchResponseDto })
  @ApiBadRequests({ validation: true, id: true, example: ['version must not be less than 0.'] })
  @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
  @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'An active coordinator is required to approve a final route batch.' })
  @ApiNotFound({ code: 'ROUTE_BATCH_NOT_FOUND', message: 'Route batch not found.' })
  @ApiConflict(
    { code: 'ROUTE_BATCH_VERSION_CONFLICT', message: 'The route batch changed. Reload it before approving.' },
    { code: 'DISPATCH_VERSION_CONFLICT', message: 'One or more dispatches changed. Reload the route batch.' },
    { code: 'ROUTE_BATCH_NOT_PENDING_FINAL_REVIEW', message: 'Only a validated batch pending final review can be approved.' },
    { code: 'ROUTE_BATCH_DRIVER_REQUIRED', message: 'Assign a proposed driver before final approval.' },
    { code: 'ROUTE_BATCH_DRIVER_NOT_AVAILABLE', message: 'The proposed driver is inactive or already assigned that day.' },
    { code: 'ROUTE_BATCH_VEHICLE_REQUIRED', message: 'Assign a vehicle before final approval.' },
    { code: 'ROUTE_BATCH_VEHICLE_NOT_ACTIVE', message: 'The assigned vehicle must be active.' },
    { code: 'ROUTE_BATCH_RESOURCE_CONFLICT', message: 'The assigned vehicle is unavailable for this date.' },
    { code: 'ROUTE_CAPACITY_EXCEEDED', message: 'The route exceeds vehicle capacity.' },
    { code: 'DISPATCH_NOT_READY_FOR_FINAL_APPROVAL', message: 'A dispatch has an incomplete destination, invalid promise window or unsupported pickup type.' },
    { code: 'DISPATCH_PACKAGES_REQUIRED', message: 'Every dispatch must have registered packages.' },
    { code: 'DISPATCH_ORDER_IN_MULTIPLE_BATCHES', message: 'An order already belongs to another active batch.' },
    { code: 'ROUTE_BATCH_HAS_NO_APPROVALS', message: 'The route batch has no dispatches to assign.' },
  )
  async approveFinal(
    @Param('id', ParseIdPipe) id: number,
    @Body() dto: ApproveFinalRouteBatchDto,
    @CurrentUser('id') actorUserId: number,
  ): Promise<ApproveFinalRouteBatchResponseDto> {
    return await this.finalApprovalService.approve(id, dto, actorUserId);
  }

  @Patch(':id/vehicle')
  @Roles(RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR)
  @ApiOperation({
    summary: 'Assign a vehicle after validating route capacity',
    description:
      'Assigns a vehicle to a provisional route batch only when total package weight and volume fit its capacity and every configured per-package dimension limit is met. Dispatches without package records use their estimated weight, marked as estimated in the returned report.',
  })
  @ApiIdParam('Route batch')
  @ApiOkResponse({ type: RouteBatchVehicleAssignmentDto })
  @ApiBadRequests({
    validation: true,
    id: true,
    example: ['vehicleId must be an integer number.'],
  })
  @ApiUnauthorized({
    code: 'INVALID_TOKEN',
    message: 'Invalid or expired token.',
  })
  @ApiForbidden({
    code: 'INSUFFICIENT_PERMISSIONS',
    message: 'You do not have permission to perform this action.',
  })
  @ApiNotFound(
    {
      code: 'ROUTE_BATCH_NOT_FOUND',
      message: 'Route batch not found.',
    },
    { code: 'VEHICLE_NOT_FOUND', message: 'Vehicle not found.' },
  )
  @ApiConflict(
    {
      code: 'ROUTE_BATCH_NOT_PROVISIONAL',
      message:
        'A vehicle can only be assigned while the route batch is provisional.',
    },
    {
      code: 'ROUTE_CAPACITY_EXCEEDED',
      message:
        'The route exceeds the selected vehicle capacity or package dimensions.',
    },
  )
  async assignVehicle(
    @Param('id', ParseIdPipe) id: number,
    @Body() dto: AssignRouteBatchVehicleDto,
  ): Promise<RouteBatchVehicleAssignmentDto> {
    return await this.vehicleService.assign(id, dto.vehicleId);
  }

  @Patch(':id/reviewer')
  @Roles(RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR)
  @ApiOperation({
    summary: 'Reassign the reviewer of a provisional batch',
    description:
      "Hands the whole provisional batch to another active coordinator or supervisor (D-42). The change is recorded in the batch's event log (`reviewer_reassigned`) with the user who made it, the previous reviewer and the optional reason. Only allowed while the batch is `provisional`. Sending the reviewer the batch already has answers 200 and changes nothing. It does not change the batch `version`. Requires coordinator or supervisor role, or root.",
  })
  @ApiIdParam('Route batch')
  @ApiOkResponse({ type: RouteBatchReviewerDto })
  @ApiBadRequests({
    validation: true,
    id: true,
    example: ['The reviewer user ID must be an integer.'],
  })
  @ApiUnauthorized({
    code: 'INVALID_TOKEN',
    message: 'Invalid or expired token.',
  })
  @ApiForbidden({
    code: 'INSUFFICIENT_PERMISSIONS',
    message: 'You do not have permission to perform this action.',
  })
  @ApiNotFound({
    code: 'ROUTE_BATCH_NOT_FOUND',
    message: 'Route batch not found.',
  })
  @ApiConflict(
    {
      code: 'ROUTE_BATCH_NOT_PROVISIONAL',
      message:
        'The reviewer can only be assigned while the batch is provisional (current status: confirmed).',
    },
    {
      code: 'ROUTE_BATCH_REVIEWER_NOT_ELIGIBLE',
      message: 'The reviewer must be an active coordinator or supervisor.',
    },
  )
  async reassignReviewer(
    @Param('id', ParseIdPipe) id: number,
    @Body() dto: UpdateRouteBatchReviewerDto,
    @CurrentUser('id') userId: number,
  ): Promise<RouteBatchReviewerDto> {
    return await this.reviewerService.reassignReviewer(
      id,
      dto.reviewerUserId,
      userId,
      dto.reason,
    );
  }
}
