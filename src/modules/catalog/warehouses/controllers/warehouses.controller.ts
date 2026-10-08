import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiOkResponse } from '@nestjs/swagger';
import { WarehousesService } from '../services/warehouses.service.js';
import { WarehouseDto } from '../dto/warehouse.dto.js';
import { FindAllWarehousesParamsDto } from '../dto/find-all-warehouses-params.dto.js';
import { FindAllWarehousesResponseDto } from '../dto/find-all-warehouses-response.dto.js';
import { PaginationResponseDto } from '../../../../shared/dto/index.js';
import { ApiNotFound, ApiUnauthorized, ApiBadRequests, ApiIdParam } from '../../../../shared/utils/swagger/index.js';
import { Roles } from '../../../../app/auth/decorators/index.js';
import { ParseIdPipe } from '../../../../shared/pipes/index.js';
import { RoleEnum } from '../../../../shared/enums/index.js';

/**
 * Error dictionary for this module:
 *   WAREHOUSE_NOT_FOUND        404 — No warehouse with the given ID exists or it was deleted.
 *   INVALID_TOKEN              401 — JWT is missing, malformed, or expired.
 *   INSUFFICIENT_PERMISSIONS   403 — Authenticated but role does not meet the endpoint requirement.
 *
 * Corrección de ES-26/ST-26.1 — read-only catalog: no create/update/delete endpoint exists. Seeded
 * directly in the database (see delivery-dispatch-db).
 */
@ApiTags('Warehouses')
@ApiBearerAuth('access-token')
@Controller('warehouses')
export class WarehousesController {
    constructor(private readonly warehousesService: WarehousesService) {}

    @Get()
    @Roles(RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR)
    @ApiOperation({
        summary:     'List warehouses',
        description: 'Returns a paginated list (10 per page by default, up to 100) of the warehouses that have not been deleted, ordered by name by default (`sortBy`/`sortOrder`; ties broken by id). `search` matches the code or the name; `active` narrows the list and is kept when a search is also given. Requires coordinator or supervisor role, or root.',
    })
    @ApiBadRequests({ validation: true, example: ["The 'sortBy' parameter must be one of: code, name, createdAt."] })
    @ApiOkResponse({ type: FindAllWarehousesResponseDto })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async findAll(@Query() params: FindAllWarehousesParamsDto): Promise<PaginationResponseDto<WarehouseDto>> {
        return await this.warehousesService.findAll(WarehouseDto, params);
    }

    @Get(':id')
    @Roles(RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR)
    @ApiOperation({
        summary:     'Get a warehouse by ID',
        description: 'Returns a single warehouse by its numeric ID, whether it is enabled or disabled. A deleted warehouse is not found. Requires coordinator or supervisor role, or root.',
    })
    @ApiIdParam('Warehouse')
    @ApiBadRequests({ id: true })
    @ApiOkResponse({ type: WarehouseDto })
    @ApiNotFound({ code: 'WAREHOUSE_NOT_FOUND', message: 'Warehouse not found.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async findOne(@Param('id', ParseIdPipe) id: number): Promise<WarehouseDto> {
        return await this.warehousesService.findOneById(WarehouseDto, id);
    }
}
