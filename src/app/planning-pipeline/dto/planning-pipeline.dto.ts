import { ApiProperty } from '@nestjs/swagger';
import { PaginationResponseDto } from '../../../shared/dto/pagination-response.dto.js';
import { PipelineStage } from '../domain/pipeline-stage.js';

export class NamedRefDto {
    @ApiProperty({ type: 'integer', description: 'ID' })
    id!: number;

    @ApiProperty({ type: String, description: 'Display name (or plate for a vehicle)' })
    name!: string;
}

export class WeightCapacityDto {
    @ApiProperty({ type: String, enum: ['kg'], description: 'Unit of every number of this measure' })
    unit!: 'kg';

    @ApiProperty({ type: 'number', format: 'double', minimum: 0, description: 'Load of the batch in kilograms' })
    actual!: number;

    @ApiProperty({ type: 'number', format: 'double', minimum: 0, description: 'Weight capacity of the vehicle in kilograms' })
    capacity!: number;

    @ApiProperty({ type: 'number', format: 'double', minimum: 0, description: 'Weight used over weight capacity, in percent. It never mixes volume' })
    usedPercent!: number;

    @ApiProperty({ type: 'number', format: 'double', minimum: 0, description: 'Kilograms still free' })
    remaining!: number;

    @ApiProperty({ type: 'number', format: 'double', minimum: 0, description: 'Kilograms above the capacity (0 when it fits)' })
    excess!: number;

    @ApiProperty({ type: Boolean, description: 'The weight exceeds the vehicle capacity' })
    exceeded!: boolean;
}

export class VolumeCapacityDto {
    @ApiProperty({ type: String, enum: ['m3'], description: 'Unit of every number of this measure' })
    unit!: 'm3';

    @ApiProperty({ type: 'number', format: 'double', minimum: 0, description: 'Load of the batch in cubic meters' })
    actual!: number;

    @ApiProperty({ type: 'number', format: 'double', minimum: 0, description: 'Volume capacity of the vehicle in cubic meters' })
    capacity!: number;

    @ApiProperty({ type: 'number', format: 'double', minimum: 0, description: 'Volume used over volume capacity, in percent. It never mixes weight' })
    usedPercent!: number;

    @ApiProperty({ type: 'number', format: 'double', minimum: 0, description: 'Cubic meters still free' })
    remaining!: number;

    @ApiProperty({ type: 'number', format: 'double', minimum: 0, description: 'Cubic meters above the capacity (0 when it fits)' })
    excess!: number;

    @ApiProperty({ type: Boolean, description: 'The volume exceeds the vehicle capacity' })
    exceeded!: boolean;
}

export class PipelineCapacityDto {
    @ApiProperty({ type: WeightCapacityDto, description: 'Weight against the weight capacity, in kg' })
    weight!: WeightCapacityDto;

    @ApiProperty({ type: VolumeCapacityDto, description: 'Volume against the volume capacity, in m³. There is no combined percentage' })
    volume!: VolumeCapacityDto;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Packages that exceed the maximum length, width or height the vehicle accepts' })
    dimensionViolationCount!: number;
}

export class PipelineBatchDto {
    @ApiProperty({ type: 'integer', description: 'Route batch ID' })
    id!: number;

    @ApiProperty({ type: String, example: 'provisional', description: 'Batch status. The batch is detail of its dispatches, never the unit of a count' })
    status!: string;

    @ApiProperty({ type: 'integer', description: 'Batch version, for the planning operations that act on it' })
    version!: number;

    @ApiProperty({ type: String, format: 'date', description: 'Shift date of the batch (YYYY-MM-DD)' })
    shiftDate!: string;

    @ApiProperty({ type: NamedRefDto, nullable: true, description: 'Assigned vehicle (`name` is the plate), `null` while there is none' })
    vehicle!: NamedRefDto | null;

    @ApiProperty({ type: NamedRefDto, nullable: true, description: 'Driver, or the proposed driver before the second approval; `null` while there is none' })
    driver!: NamedRefDto | null;

    @ApiProperty({ type: PipelineCapacityDto, nullable: true, description: 'Load against the vehicle, kg and m³ separately. `null` when the batch has no vehicle: no capacity is invented' })
    capacity!: PipelineCapacityDto | null;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Dispatches the batch carries, of any status (informational detail, not a KPI)' })
    dispatchCount!: number;
}

export class PipelineExceptionDto {
    @ApiProperty({ type: [String], example: ['capacity_exceeded_kg'], description: 'Exception codes: `address_invalid`, `zone_missing`, `deadline_exceeded`, `no_vehicle_fits`, `no_vehicle_available`, `rescheduled_date_not_plannable`, `capacity_exceeded_kg`, `capacity_exceeded_m3`, `package_dimensions_exceeded`, `inconsistent_state`' })
    codes!: string[];

    @ApiProperty({ type: String, nullable: true, description: 'Readable reason built from the codes (one sentence per code)' })
    reason!: string | null;
}

export class PipelineDispatchDto {
    @ApiProperty({ type: 'integer', description: 'Dispatch ID: the unit of every count of the pipeline' })
    dispatchId!: number;

    @ApiProperty({ enum: PipelineStage, description: 'Stage of the dispatch. A dispatch is in exactly one stage' })
    stage!: PipelineStage;

    @ApiProperty({ type: String, example: 'scheduled', description: 'Current dispatch status' })
    status!: string;

    @ApiProperty({ type: 'integer', nullable: true, description: 'Batch of the dispatch (detail, see `batches`); `null` without batch' })
    routeBatchId!: number | null;

    @ApiProperty({ type: NamedRefDto, nullable: true, description: 'Delivery zone, `null` when the dispatch has none' })
    zone!: NamedRefDto | null;

    @ApiProperty({ type: NamedRefDto, nullable: true, description: 'Origin warehouse, `null` when unknown' })
    warehouse!: NamedRefDto | null;

    @ApiProperty({ type: String, format: 'date', nullable: true, description: 'Operating day (YYYY-MM-DD), `null` without batch and without window' })
    operatingDate!: string | null;

    @ApiProperty({ type: String, enum: ['morning', 'afternoon'], nullable: true, description: 'Shift derived from the start of the promise window, `null` without window' })
    shift!: 'morning' | 'afternoon' | null;

    @ApiProperty({ type: NamedRefDto, nullable: true, description: 'Vehicle of the batch (`name` is the plate)' })
    vehicle!: NamedRefDto | null;

    @ApiProperty({ type: NamedRefDto, nullable: true, description: 'Driver or proposed driver of the batch' })
    driver!: NamedRefDto | null;

    @ApiProperty({ type: PipelineExceptionDto, nullable: true, description: 'Why the dispatch is an exception; `null` for any other stage' })
    exception!: PipelineExceptionDto | null;

    @ApiProperty({ type: String, example: '/dispatches/42/detail', description: 'Path (under the API prefix) of the dispatch detail, where the coordinator solves the exception. Only the coordinator reaches this endpoint, and the coordinator can open it' })
    detailPath!: string;
}

export class PipelineStageCountsDto {
    @ApiProperty({ type: 'integer', minimum: 0, description: 'Dispatches ready and without batch. Not the whole backlog: the other stages are counted next to it' })
    ready_unbatched!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Dispatches in a provisional batch or in review' })
    provisional_review!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Dispatches in a confirmed batch' })
    confirmed_assigned!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Dispatches on a route in execution' })
    in_execution!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Dispatches with an exception to solve' })
    exception!: number;
}

export class PipelineSummaryDto {
    @ApiProperty({ type: PipelineStageCountsDto, description: 'Dispatches per stage (one dispatch, one count; batches are never counted)' })
    byStage!: PipelineStageCountsDto;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Dispatches in the pipeline: the sum of `byStage`' })
    total!: number;
}

export class PlanningPipelineResponseDto extends PaginationResponseDto<PipelineDispatchDto> {
    @ApiProperty({ type: [PipelineDispatchDto], description: 'Dispatches of the page, most urgent first' })
    declare data: PipelineDispatchDto[];

    @ApiProperty({ type: String, format: 'date', description: 'Operating day of the view (YYYY-MM-DD)' })
    date!: string;

    @ApiProperty({ type: PipelineSummaryDto, description: 'Counts of every stage for the applied filters (except `stage`)' })
    summary!: PipelineSummaryDto;

    @ApiProperty({ type: [PipelineBatchDto], description: 'Batches of the dispatches of the page, only as detail with their capacity in kg and m³' })
    batches!: PipelineBatchDto[];
}
