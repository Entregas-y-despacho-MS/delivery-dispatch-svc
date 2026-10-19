import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../../shared/decorators/current-user.decorator.js';
import { ApiBadRequests, ApiForbidden, ApiUnauthorized } from '../../../shared/utils/swagger/index.js';
import { DriverOnly } from '../../auth/decorators/index.js';
import { DriverMetricsParamsDto } from '../dto/driver-metrics-params.dto.js';
import { DriverMetricsDto } from '../dto/driver-metrics.dto.js';
import { DriverMetricsService } from '../services/driver-metrics.service.js';

/**
 * Error dictionary: VALIDATION_FAILED 400, INVALID_TOKEN 401, INSUFFICIENT_PERMISSIONS 403
 */
@ApiTags('Driver metrics')
@ApiBearerAuth('access-token')
@Controller('drivers/me')
export class DriverMetricsController {
    constructor(private readonly metrics: DriverMetricsService) {}

    @Get('metrics')
    @DriverOnly()
    @ApiOperation({
        summary: 'Performance metrics of the signed-in driver (RF-U09)',
        description: 'Deliveries, on-time percentage, assigned dispatches and average rating for `today`, `week` or `month` (Bolivia days). The driver is always the one in the token. Computed with SQL aggregations and cached in Redis for 5 minutes; the cache is dropped when one of the driver\'s deliveries is confirmed. If Redis does not answer the figures are computed from PostgreSQL. A driver with no history gets zeros and `rating: null` / `ratingsCount: 0`, and the app shows the neutral initial rating (5.0).',
    })
    @ApiOkResponse({ type: DriverMetricsDto })
    @ApiBadRequests({ validation: true, example: ['The \'period\' parameter must be one of: today, week, month.'] })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission.' })
    async getMetrics(@CurrentUser('id') driverId: number, @Query() params: DriverMetricsParamsDto): Promise<DriverMetricsDto> {
        return await this.metrics.get(driverId, params.period);
    }
}
