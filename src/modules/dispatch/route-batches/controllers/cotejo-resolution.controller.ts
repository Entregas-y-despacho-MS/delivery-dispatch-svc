import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CoordinatorOnly } from '../../../../app/auth/decorators/index.js';
import { CurrentUser } from '../../../../shared/decorators/current-user.decorator.js';
import { ParseIdPipe } from '../../../../shared/pipes/index.js';
import {
  ApiBadRequests,
  ApiConflict,
  ApiForbidden,
  ApiIdParam,
  ApiNotFound,
  ApiUnauthorized,
} from '../../../../shared/utils/swagger/index.js';
import { RouteBatchCotejoResolutionService } from '../services/route-batch-cotejo-resolution.service.js';
import { ResolveCotejoDto } from '../dto/resolve-cotejo.dto.js';
import { ResolveCotejoResponseDto } from '../dto/resolve-cotejo-response.dto.js';

/**
 * ST-241.3 — the coordinator marks a failed package check as resolved (ES-241). Lives under `/dispatches` because
 * the stop is a dispatch, but belongs to the route-batch module: it writes the event `RouteBatchStartService` reads.
 *
 * Error dictionary: VALIDATION_FAILED 400 | INVALID_TOKEN 401 | INSUFFICIENT_PERMISSIONS 403 | DISPATCH_NOT_FOUND 404 |
 * ROUTE_BATCH_NOT_IN_EXECUTION 409 | COTEJO_DISPATCH_NOT_ASSIGNED 409 | COTEJO_EXCLUSION_NOT_PENDING 409.
 */
@ApiTags('Route batches')
@ApiBearerAuth('access-token')
@Controller('dispatches')
export class CotejoResolutionController {
  constructor(private readonly resolution: RouteBatchCotejoResolutionService) {}

  @Post(':id/cotejo-resolved')
  @HttpCode(HttpStatus.OK)
  @CoordinatorOnly()
  @ApiOperation({
    summary: 'Mark a package-check failure as resolved (coordinator)',
    description:
      'ST-241.3. For a stop left out of the route by a failed package check (listed by `GET /route-batches/cotejo-exclusions`): the package showed up, so the coordinator records the event `cotejo_resolved`. The stop leaves the list. It does not change the status of the dispatch (it stays `assigned`) and does not start anything: the coordinator decides afterwards (the stop can leave with the route if it has not left yet, or be rescheduled or cancelled). One resolution frees the whole stop, even if several of its packages failed. It answers 409 when the route batch is not `in_execution`, the dispatch is not `assigned` or it has no unresolved failure (so a second call does not write a second event). Optional `note` (up to 500 characters). Requires coordinator role, or root.',
  })
  @ApiIdParam('Dispatch')
  @ApiOkResponse({ type: ResolveCotejoResponseDto })
  @ApiBadRequests({
    validation: true,
    id: true,
    example: ['note must not be longer than 500 characters.'],
  })
  @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
  @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' })
  @ApiNotFound({ code: 'DISPATCH_NOT_FOUND', message: 'Dispatch not found.' })
  @ApiConflict(
    { code: 'ROUTE_BATCH_NOT_IN_EXECUTION', message: 'The package check can only be resolved while the route batch is in execution (current status: closed).' },
    { code: 'COTEJO_DISPATCH_NOT_ASSIGNED', message: 'Only an assigned dispatch can be resolved (current status: rescheduled).' },
    { code: 'COTEJO_EXCLUSION_NOT_PENDING', message: 'The dispatch has no unresolved package-check failure in its route batch.' },
  )
  async resolve(
    @Param('id', ParseIdPipe) id: number,
    @Body() dto: ResolveCotejoDto,
    @CurrentUser('id') coordinatorId: number,
  ): Promise<ResolveCotejoResponseDto> {
    return await this.resolution.resolve(id, dto, coordinatorId);
  }
}
