import {
    Controller, Get, Post, Put, Delete,
    Body, Param, Query, HttpCode, HttpStatus,
} from '@nestjs/common';
import {
    ApiTags, ApiBearerAuth, ApiOperation,
    ApiOkResponse, ApiCreatedResponse, ApiNoContentResponse,
} from '@nestjs/swagger';
import { DeliveryZonesService } from '../services/delivery-zones.service.js';
import { DeliveryZoneDto } from '../dto/delivery-zone.dto.js';
import { CreateDeliveryZoneDto } from '../dto/create-delivery-zone.dto.js';
import { UpdateDeliveryZoneDto } from '../dto/update-delivery-zone.dto.js';
import { FindAllDeliveryZonesParamsDto } from '../dto/find-all-delivery-zones-params.dto.js';
import { FindAllDeliveryZonesResponseDto } from '../dto/find-all-delivery-zones-response.dto.js';
import { ParseIdPipe } from '../../../../shared/pipes/index.js';
import { PaginationResponseDto } from '../../../../shared/dto/index.js';
import { ApiNotFound, ApiUnauthorized, ApiConflict, ApiBadRequests, ApiIdParam } from '../../../../shared/utils/swagger/index.js';
import { CoordinatorOnly } from '../../../../app/auth/decorators/index.js';

/**
 * Error dictionary for this module:
 *   DELIVERY_ZONE_NOT_FOUND         404 — No delivery zone with the given ID exists.
 *   DELIVERY_ZONE_CODE_ALREADY_EXISTS 409 — Another zone already uses this code.
 *   INVALID_TOKEN                   401 — JWT is missing, malformed, or expired.
 *   INSUFFICIENT_PERMISSIONS        403 — Authenticated but role does not meet the endpoint requirement.
 *
 * RF-A29 — administrado por el coordinador de logística (@CoordinatorOnly(), root bypasea).
 */
@ApiTags('Delivery Zones')
@ApiBearerAuth('access-token')
@Controller('delivery-zones')
export class DeliveryZonesController {
    constructor(private readonly deliveryZonesService: DeliveryZonesService) {}

    @Get()
    @CoordinatorOnly()
    @ApiOperation({
        summary:     'List delivery zones',
        description: 'Returns a paginated list of delivery zones (10 per page by default, up to 100). `search` matches the code or the name (case-insensitive). Requires coordinator role or root.',
    })
    @ApiBadRequests({ validation: true, example: ["The 'limit' parameter must be <= 100."] })
    @ApiOkResponse({ type: FindAllDeliveryZonesResponseDto })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async findAll(@Query() params: FindAllDeliveryZonesParamsDto): Promise<PaginationResponseDto<DeliveryZoneDto>> {
        return await this.deliveryZonesService.findAll(DeliveryZoneDto, params);
    }

    @Get(':id')
    @CoordinatorOnly()
    @ApiOperation({
        summary:     'Get a delivery zone by ID',
        description: 'Returns one delivery zone by ID. A deleted zone is not found. Requires coordinator role or root.',
    })
    @ApiIdParam('Delivery zone')
    @ApiBadRequests({ id: true })
    @ApiOkResponse({ type: DeliveryZoneDto })
    @ApiNotFound({ code: 'DELIVERY_ZONE_NOT_FOUND', message: 'Delivery zone not found.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async findOne(@Param('id', ParseIdPipe) id: number): Promise<DeliveryZoneDto> {
        return await this.deliveryZonesService.findOneById(DeliveryZoneDto, id);
    }

    @Post()
    @CoordinatorOnly()
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({
        summary:     'Create a delivery zone',
        description: 'Creates a delivery zone. All three fields are required: a unique `code` (409 DELIVERY_ZONE_CODE_ALREADY_EXISTS if another zone uses it), a `name` and the base `estimatedTimeMin` (a positive whole number of minutes). Requires coordinator role or root.',
    })
    @ApiBadRequests({ validation: true, example: ['Code is required.', 'Estimated time must be a positive number.'] })
    @ApiCreatedResponse({ type: DeliveryZoneDto })
    @ApiConflict({ code: 'DELIVERY_ZONE_CODE_ALREADY_EXISTS', message: 'This code already belongs to another delivery zone.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async create(@Body() dto: CreateDeliveryZoneDto): Promise<DeliveryZoneDto> {
        return await this.deliveryZonesService.create(DeliveryZoneDto, dto);
    }

    @Put(':id')
    @CoordinatorOnly()
    @ApiOperation({
        summary:     'Update a delivery zone',
        description: 'Partially updates a delivery zone: only the fields sent are changed, and `null` is rejected. A changed `code` must not belong to another zone (409). Requires coordinator role or root.',
    })
    @ApiIdParam('Delivery zone')
    @ApiBadRequests({ validation: true, example: ['Estimated time must be an integer.'], id: true })
    @ApiOkResponse({ type: DeliveryZoneDto })
    @ApiNotFound({ code: 'DELIVERY_ZONE_NOT_FOUND', message: 'Delivery zone not found.' })
    @ApiConflict({ code: 'DELIVERY_ZONE_CODE_ALREADY_EXISTS', message: 'This code already belongs to another delivery zone.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async update(
        @Param('id', ParseIdPipe) id: number,
        @Body() dto: UpdateDeliveryZoneDto,
    ): Promise<DeliveryZoneDto> {
        return await this.deliveryZonesService.update(DeliveryZoneDto, id, dto);
    }

    @Delete(':id')
    @CoordinatorOnly()
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({
        summary:     'Delete a delivery zone',
        description: 'Soft-deletes the delivery zone: it no longer appears in lists or lookups. Requires coordinator role or root.',
    })
    @ApiIdParam('Delivery zone')
    @ApiBadRequests({ id: true })
    @ApiNoContentResponse({ description: 'Delivery zone deleted successfully.' })
    @ApiNotFound({ code: 'DELIVERY_ZONE_NOT_FOUND', message: 'Delivery zone not found.' })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async remove(@Param('id', ParseIdPipe) id: number): Promise<void> {
        return await this.deliveryZonesService.remove(id);
    }
}
