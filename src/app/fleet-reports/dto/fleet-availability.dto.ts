import { ApiProperty } from '@nestjs/swagger';
import { VehicleStatusEnum } from '../../../shared/enums/index.js';

/** Why a figure is `N/D` (null) instead of a number. */
export enum FleetUnavailableReason {
    /** Only the current vehicle status is stored: no availability for a past cut-off. */
    NO_STATUS_HISTORY = 'no_status_history',
    /** The vehicle has no route in the period, so no load can be attributed to it. */
    NO_ROUTE_IN_PERIOD = 'no_route_in_period',
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

    @ApiProperty({ enum: FleetUnavailableReason, nullable: true, description: 'Why the four figures are N/D; null when they are numbers' })
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
    @ApiProperty({ type: 'number', minimum: 0, description: 'Estimated load attributed to the vehicle from its routes in the period' })
    used!: number;

    @ApiProperty({ type: 'number', minimum: 0, description: 'Capacity of the vehicle in the same unit' })
    capacity!: number;

    @ApiProperty({ type: 'number', minimum: 0, description: 'used / capacity, not rounded up to 100: above 1 means over capacity' })
    ratio!: number;
}

export class FleetLoadDto {
    @ApiProperty({ type: FleetLoadFigureDto, nullable: true, description: 'Kilograms against `capacity_kg`. null when there is no attribution' })
    kg!: FleetLoadFigureDto | null;

    @ApiProperty({ type: FleetLoadFigureDto, nullable: true, description: 'Cubic metres against `capacity_m3`. Independent from kg. null when there is no attribution' })
    m3!: FleetLoadFigureDto | null;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Dispatches of the vehicle routes counted (n)' })
    n!: number;

    @ApiProperty({ enum: FleetUnavailableReason, nullable: true, description: 'Why kg and m3 are N/D; null when they are numbers' })
    unavailableReason!: FleetUnavailableReason | null;
}

export class FleetAvailabilityVehicleDto {
    @ApiProperty({ type: 'integer' })
    vehicleId!: number;

    @ApiProperty({ example: '1234-ABC' })
    plate!: string;

    @ApiProperty({ enum: VehicleStatusEnum, nullable: true, description: 'Current fleet status; null (N/D) when the cut-off is in the past' })
    fleetStatus!: VehicleStatusEnum | null;

    @ApiProperty({ type: FleetMaintenanceSummaryDto })
    maintenance!: FleetMaintenanceSummaryDto;

    @ApiProperty({ type: FleetLoadDto })
    load!: FleetLoadDto;
}

export class FleetAvailabilityDriverDto {
    @ApiProperty({ type: 'integer' })
    driverId!: number;

    @ApiProperty({ type: String, nullable: true })
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

export class FleetAvailabilityDto {
    @ApiProperty({ type: FleetAvailabilityCutoffDto })
    cutoff!: FleetAvailabilityCutoffDto;

    @ApiProperty({ type: String, format: 'date', description: 'First Bolivia day of the maintenance and productivity period' })
    from!: string;

    @ApiProperty({ type: String, format: 'date', description: 'Last Bolivia day of the period' })
    to!: string;

    @ApiProperty({ example: { time: 'calendar_days', load: ['kg', 'm3'] }, description: 'Units used: calendar days (never hours) and kg / m³ kept apart' })
    units!: { time: 'calendar_days'; load: ['kg', 'm3'] };

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Vehicles in the answer after the filters (n). 0 = "Sin datos"' })
    n!: number;

    @ApiProperty({ type: FleetAvailabilitySummaryDto })
    availability!: FleetAvailabilitySummaryDto;

    @ApiProperty({ type: FleetMaintenanceSummaryDto, description: 'Maintenance of all the vehicles in the answer' })
    maintenance!: FleetMaintenanceSummaryDto;

    @ApiProperty({ type: [FleetAvailabilityVehicleDto] })
    vehicles!: FleetAvailabilityVehicleDto[];

    @ApiProperty({ type: FleetDriverProductivityDto })
    productivity!: FleetDriverProductivityDto;
}
