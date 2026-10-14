import { Body, Controller, Param, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RouteBatchReviewerService } from '../services/route-batch-reviewer.service.js';
import { UpdateRouteBatchReviewerDto } from '../dto/update-route-batch-reviewer.dto.js';
import { RouteBatchReviewerDto } from '../dto/route-batch-reviewer.dto.js';
import { Roles } from '../../../../app/auth/decorators/index.js';
import { CurrentUser } from '../../../../shared/decorators/current-user.decorator.js';
import { ParseIdPipe } from '../../../../shared/pipes/index.js';
import { RoleEnum } from '../../../../shared/enums/index.js';
import { ApiBadRequests, ApiConflict, ApiForbidden, ApiIdParam, ApiNotFound, ApiUnauthorized } from '../../../../shared/utils/swagger/index.js';

/**
 * ST-50.4 — reviewer of a provisional route batch (D-42).
 *
 * Error dictionary: VALIDATION_FAILED 400 | INVALID_TOKEN 401 | INSUFFICIENT_PERMISSIONS 403 |
 * ROUTE_BATCH_NOT_FOUND 404 | ROUTE_BATCH_NOT_PROVISIONAL 409 | ROUTE_BATCH_REVIEWER_NOT_ELIGIBLE 409.
 */
@ApiTags('Route batches')
@ApiBearerAuth('access-token')
@Controller('route-batches')
export class RouteBatchesController {
    constructor(private readonly reviewerService: RouteBatchReviewerService) {}

    @Patch(':id/reviewer')
    @Roles(RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR)
    @ApiOperation({
        summary:     'Reassign the reviewer of a provisional batch',
        description: "Hands the whole provisional batch to another active coordinator or supervisor (D-42). The change is recorded in the batch's event log (`reviewer_reassigned`) with the user who made it, the previous reviewer and the optional reason. Only allowed while the batch is `provisional`. Sending the reviewer the batch already has answers 200 and changes nothing. It does not change the batch `version`. Requires coordinator or supervisor role, or root.",
    })
    @ApiIdParam('Route batch')
    @ApiOkResponse({ type: RouteBatchReviewerDto })
    @ApiBadRequests({ validation: true, id: true, example: ['The reviewer user ID must be an integer.'] })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' })
    @ApiNotFound({ code: 'ROUTE_BATCH_NOT_FOUND', message: 'Route batch not found.' })
    @ApiConflict(
        { code: 'ROUTE_BATCH_NOT_PROVISIONAL', message: 'The reviewer can only be assigned while the batch is provisional (current status: confirmed).' },
        { code: 'ROUTE_BATCH_REVIEWER_NOT_ELIGIBLE', message: 'The reviewer must be an active coordinator or supervisor.' },
    )
    async reassignReviewer(
        @Param('id', ParseIdPipe) id: number,
        @Body() dto: UpdateRouteBatchReviewerDto,
        @CurrentUser('id') userId: number,
    ): Promise<RouteBatchReviewerDto> {
        return await this.reviewerService.reassignReviewer(id, dto.reviewerUserId, userId, dto.reason);
    }
}
