import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { FleetService } from '../services/fleet.service.js';
import { FleetLivePositionDto } from '../dto/live-position.dto.js';
import { Roles } from '../../auth/decorators/index.js';
import { RoleEnum } from '../../../shared/enums/index.js';
import { ApiUnauthorized, ApiForbidden } from '../../../shared/utils/swagger/index.js';

/**
 * RF-A13 — mapa en vivo de la flota. Error dictionary: INVALID_TOKEN 401 | INSUFFICIENT_PERMISSIONS 403.
 */
@ApiTags('Fleet')
@ApiBearerAuth('access-token')
@Controller('fleet')
export class FleetController {
    constructor(private readonly fleetService: FleetService) {}

    @Get('live-positions')
    @Roles(RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR)
    @ApiOperation({
        summary:     'Live position of every vehicle currently on route',
        description: 'One row per route batch `in_execution`, with the driver, the vehicle plate, the current stop (`in_transit`, or the next open one if none is), and the last reported GPS point and time. Moving to a new point pushes `dispatch.location.updated` to the live board (socket, `dispatch-board` room, at most once every 2s per driver) with the same `routeBatchId`/driverId/vehicleId so a client can match the two. An empty array means no route is currently in execution. Requires coordinator or supervisor role, or root.',
    })
    @ApiOkResponse({ type: [FleetLivePositionDto] })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    @ApiForbidden({ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' })
    async findLivePositions(): Promise<FleetLivePositionDto[]> {
        return await this.fleetService.findLivePositions();
    }
}
