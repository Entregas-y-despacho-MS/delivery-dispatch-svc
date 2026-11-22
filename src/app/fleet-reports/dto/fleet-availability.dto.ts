import { ApiExtraModels, ApiProperty, getSchemaPath } from '@nestjs/swagger';
import { VehicleStatusEnum } from '../../../shared/enums/index.js';

/** Why a figure is `N/D` (null) instead of a number. */
export enum FleetUnavailableReason {
    /** Only the current vehicle status is stored: no availability for a past cut-off. */
    NO_STATUS_HISTORY = 'no_status_history',
    /** The vehicle has no route in the period, so no load can be attributed to it. */
    NO_ROUTE_IN_PERIOD = 'no_route_in_period',
    /** The routes of the period have no weight / volume estimate on their dispatches. */
    NO_ESTIMATE = 'no_estimate',
    /** The role may only see aggregates. */
    ROLE_RESTRICTED = 'role_restricted',
}

export class FleetAvailabilityCutoffDto {
    @ApiProperty({ type: String, format: 'date', description: 'Bolivia day of the cut-off' })
    date!: string;

    @ApiProperty({ enum: ['current', 'past'], description: '`current`: the state is the one stored now. `past`: the state at that day is not stored, so the availability is `N/D`' })
    kind!: 'current' | 'past';
}

export class FleetAvailabilitySummaryDto {
    @ApiProperty({ type: 'integer', nullable: true, description: 'Active (assignable) vehicles at the cut-off. null (N/D) when the cut-off is in the past' })
    assignable!: number | null;

    @ApiProperty({ type: 'integer', nullable: true, description: 'Registered active vehicles (not removed). Denominator of the availability: assignable / registered. null (N/D) when the cut-off is in the past' })
    registered!: number | null;

    @ApiProperty({ type: 'integer', nullable: true, description: 'Registered vehicles in maintenance. null (N/D) when the cut-off is in the past' })
    inMaintenance!: number | null;

    @ApiProperty({ type: 'integer', nullable: true, description: 'Registered vehicles out of service. null (N/D) when the cut-off is in the past' })
    outOfService!: number | null;

    @ApiProperty({ enum: FleetUnavailableReason, type: String, nullable: true, description: 'Why the four figures are N/D; null when they are numbers' })
    unavailableReason!: FleetUnavailableReason | null;
}

export class FleetMaintenanceSummaryDto {
    @ApiProperty({ type: 'integer', minimum: 0, description: 'Maintenance records overlapping the period (n)' })
    count!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Calendar days (Bolivia) in maintenance inside the period: overlapping intervals of a vehicle are merged, never added twice; open maintenance counts through the end of the period. In the overall summary it is the sum over the vehicles (vehicle-days). Calendar days, not operating hours' })
    calendarDays!: number;

    @ApiProperty({ type: Boolean, description: 'true when two maintenances of one vehicle overlap, so the records may need reconciliation' })
    overlapsDetected!: boolean;
}

export class FleetLoadFigureDto {
    @ApiProperty({ type: 'number', format: 'double', minimum: 0, description: 'Estimated load of the heaviest route of the vehicle in the period, from the estimates of its dispatches (the ones without estimate are not counted: see `withoutWeight` / `withoutVolume`)' })
    used!: number;

    @ApiProperty({ type: 'number', format: 'double', minimum: 0, description: 'Capacity of the vehicle in the same unit' })
    capacity!: number;

    @ApiProperty({ type: 'number', format: 'double', minimum: 0, description: 'used / capacity, not capped at 1: above 1 means over capacity' })
    ratio!: number;
}

@ApiExtraModels(FleetLoadFigureDto)
export class FleetLoadDto {
    @ApiProperty({ allOf: [{ $ref: getSchemaPath(FleetLoadFigureDto) }], nullable: true, description: 'Kilograms against `capacity_kg`, peak of one route. null (N/D) when there is no attribution' })
    kg!: FleetLoadFigureDto | null;

    @ApiProperty({ allOf: [{ $ref: getSchemaPath(FleetLoadFigureDto) }], nullable: true, description: 'Cubic metres against `capacity_m3`, peak of one route; independent from kg (the peaks may come from different routes). null (N/D) when there is no attribution' })
    m3!: FleetLoadFigureDto | null;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Routes of the vehicle attributed in the period: approved routes (confirmed, in execution or closed) whose vehicle is this one, never inferred from the current status' })
    routes!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Dispatches of those routes, cancelled ones excluded (n)' })
    n!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Dispatches counted without a weight estimate: when above 0, `kg.used` is a lower bound' })
    withoutWeight!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Dispatches counted without a volume estimate: when above 0, `m3.used` is a lower bound' })
    withoutVolume!: number;

    @ApiProperty({ enum: FleetUnavailableReason, type: String, nullable: true, description: 'Why kg and m3 are both N/D (`no_route_in_period` or `no_estimate`); null when at least one is a number' })
    unavailableReason!: FleetUnavailableReason | null;
}

export class FleetAvailabilityVehicleDto {
    @ApiProperty({ type: 'integer', description: 'Vehicle ID' })
    vehicleId!: number;

    @ApiProperty({ example: '1234-ABC', description: 'License plate' })
    plate!: string;

    @ApiProperty({ enum: VehicleStatusEnum, type: String, nullable: true, description: 'Current fleet status; null (N/D) when the cut-off is in the past' })
    fleetStatus!: VehicleStatusEnum | null;

    @ApiProperty({ type: FleetMaintenanceSummaryDto, description: 'Maintenance of this vehicle in the period' })
    maintenance!: FleetMaintenanceSummaryDto;

    @ApiProperty({ type: FleetLoadDto, description: 'Load of this vehicle in the period, attributed only from its approved routes' })
    load!: FleetLoadDto;
}

export class FleetAvailabilityDriverDto {
    @ApiProperty({ type: 'integer', description: 'Driver (user) ID' })
    driverId!: number;

    @ApiProperty({ type: String, nullable: true, description: 'Full name of the driver; null if the user has no name stored' })
    driverName!: string | null;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Dispatches delivered in the period (n)' })
    deliveredCount!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Delivery attempts: dispatches closed in the period, delivered or not (n)' })
    attemptCount!: number;
}

export class FleetDriverProductivityDto {
    @ApiProperty({ type: Boolean, description: 'true when the role only sees aggregates and `drivers` is empty' })
    detailRestricted!: boolean;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Dispatches delivered in the period, all drivers (n)' })
    deliveredCount!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Attempts in the period, all drivers (n)' })
    attemptCount!: number;

    @ApiProperty({ type: [FleetAvailabilityDriverDto], description: 'One row per driver; always empty when `detailRestricted`' })
    drivers!: FleetAvailabilityDriverDto[];
}

export class FleetUnitsDto {
    @ApiProperty({ enum: ['calendar_days'], description: 'Unit of the maintenance time: Bolivia calendar days, never operating hours' })
    time!: 'calendar_days';

    @ApiProperty({ type: [String], example: ['kg', 'm3'], description: 'Units of the load figures, kept apart: kilograms and cubic metres' })
    load!: ['kg', 'm3'];
}

export class FleetAvailabilityDto {
    @ApiProperty({ type: FleetAvailabilityCutoffDto, description: 'The cut-off day of the availability and whether its state is stored (current) or not (past)' })
    cutoff!: FleetAvailabilityCutoffDto;

    @ApiProperty({ type: String, format: 'date', description: 'First Bolivia day of the maintenance and productivity period' })
    from!: string;

    @ApiProperty({ type: String, format: 'date', description: 'Last Bolivia day of the period' })
    to!: string;

    @ApiProperty({ type: FleetUnitsDto, description: 'Units used: calendar days (never hours) and kg / m³ kept apart' })
    units!: FleetUnitsDto;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Vehicles in the answer after the filters (n). 0 means no data' })
    n!: number;

    @ApiProperty({ type: FleetAvailabilitySummaryDto, description: 'Assignable / registered vehicles at the cut-off, apart from maintenance and out of service' })
    availability!: FleetAvailabilitySummaryDto;

    @ApiProperty({ type: FleetMaintenanceSummaryDto, description: 'Maintenance of all the vehicles in the answer' })
    maintenance!: FleetMaintenanceSummaryDto;

    @ApiProperty({ type: [FleetAvailabilityVehicleDto], description: 'One row per vehicle of the answer, ordered by plate; empty when no vehicle matches the filters' })
    vehicles!: FleetAvailabilityVehicleDto[];

    @ApiProperty({ type: FleetDriverProductivityDto, description: 'Deliveries and attempts of the period; the driver rows depend on the role of the caller' })
    productivity!: FleetDriverProductivityDto;
}
