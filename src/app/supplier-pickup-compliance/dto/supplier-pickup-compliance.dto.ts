import { ApiExtraModels, ApiProperty, getSchemaPath } from '@nestjs/swagger';
import { AppointmentCategory } from '../domain/appointment-classifier.js';

export class ComplianceFiltersDto {
    @ApiProperty({ type: String, nullable: true, description: 'Supplier filter that was applied; null when none' })
    supplierId!: string | null;

    @ApiProperty({ type: 'integer', nullable: true, description: 'Destination-warehouse filter that was applied; null when none' })
    warehouseId!: number | null;

    @ApiProperty({ type: 'integer', nullable: true, description: 'Zone filter that was applied; null when none' })
    zoneId!: number | null;

    @ApiProperty({ type: String, nullable: true, description: 'Status filter that was applied; null when none' })
    status!: string | null;
}

export class ComplianceMetricsDto {
    @ApiProperty({ type: 'integer', minimum: 0, example: 6, description: 'Numerator: expired appointments collected on or before the end of the window in force (`onTime`)' })
    numerator!: number;

    @ApiProperty({ type: 'integer', minimum: 0, example: 10, description: 'Denominator: expired appointments with a valid result (`onTime` + `late` + `failed`). Future appointments, open overdue ones, cancelled ones, those without a valid window and those with an unknown custody time are not in it' })
    denominator!: number;

    @ApiProperty({ type: 'integer', minimum: 0, example: 10, description: 'Sample size of the rate; the same figure as `denominator`, shown with the rate' })
    n!: number;

    @ApiProperty({ type: 'number', format: 'double', nullable: true, minimum: 0, maximum: 100, example: 60, description: 'numerator / denominator as a percentage with one decimal; 100 only when none is out of the appointment. null (N/D, shown as "no data") when the denominator is 0, never 0' })
    percentage!: number | null;

    @ApiProperty({ type: String, nullable: true, enum: ['missing_timestamp', 'no_valid_results'], description: 'Why `percentage` is null: `missing_timestamp` when the only expired pickups say they were collected but have no custody time, `no_valid_results` when no expired appointment has a result. null when there is a rate' })
    unavailableReason!: string | null;
}

export class ComplianceCountsDto {
    @ApiProperty({ type: 'integer', minimum: 0, description: 'Expired appointment collected on or before the end of the window in force (before the start counts as on time too)' })
    onTime!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Expired appointment collected after the end of the window in force' })
    late!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Expired appointment, not collected, whose status says it failed (`incident`, `not_delivered`)' })
    failed!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Expired appointment, not collected and not failed: an actionable exception with no result yet, out of the rate' })
    openOverdue!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Appointment whose window ends at or after the moment of the query (even if already collected early): out of the rate' })
    pendingNotDue!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Cancelled pickups: out of the rate' })
    cancelled!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Pickups whose window is missing or ends before it starts: out of the rate, never invented as compliant' })
    noValidAppointment!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Expired appointments whose status says they were collected but `custodyReceivedAt` is missing (N/D): out of the rate' })
    unknownTiming!: number;
}

export class ComplianceWindowDto {
    @ApiProperty({ type: String, format: 'date-time', description: 'Start of the window' })
    start!: string;

    @ApiProperty({ type: String, format: 'date-time', description: 'End of the window' })
    end!: string;
}

export class ComplianceSupplierDto {
    @ApiProperty({ type: String, description: 'Supplier id as Compras sent it' })
    id!: string;

    @ApiProperty({ type: String, nullable: true, description: 'Supplier name as Compras sent it; null when the event has none' })
    name!: string | null;
}

@ApiExtraModels(ComplianceSupplierDto, ComplianceWindowDto)
export class ComplianceExceptionDto {
    @ApiProperty({ type: 'integer', description: 'Dispatch of the supplier pickup' })
    dispatchId!: number;

    @ApiProperty({ enum: [AppointmentCategory.FAILED, AppointmentCategory.OPEN_OVERDUE, AppointmentCategory.LATE, AppointmentCategory.UNKNOWN_TIMING], description: 'Why it is an exception. `failed`, `openOverdue` and `unknownTiming` are not completed pickups; `late` was collected after the window' })
    category!: AppointmentCategory;

    @ApiProperty({ type: String, description: 'Current status of the dispatch' })
    status!: string;

    @ApiProperty({ type: String, description: 'Purchase order that originated the pickup' })
    purchaseOrderRef!: string;

    @ApiProperty({ allOf: [{ $ref: getSchemaPath(ComplianceSupplierDto) }], nullable: true, description: 'Supplier of the pickup; null when no event carries it' })
    supplier!: ComplianceSupplierDto | null;

    @ApiProperty({ type: 'integer', nullable: true, description: 'Warehouse where the cargo will be received; null when unknown' })
    destinationWarehouseId!: number | null;

    @ApiProperty({ allOf: [{ $ref: getSchemaPath(ComplianceWindowDto) }], nullable: true, description: 'Window in force (the last one accepted); null when it is missing' })
    window!: ComplianceWindowDto | null;

    @ApiProperty({ allOf: [{ $ref: getSchemaPath(ComplianceWindowDto) }], nullable: true, description: 'Original window, kept for audit: the one the first window change replaced. null when the window was never changed' })
    originalWindow!: ComplianceWindowDto | null;

    @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'Moment of the first reschedule; null when it was never rescheduled' })
    rescheduledAt!: string | null;

    @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'Moment the carrier confirmed the collection: the instant compliance is measured with. null when not collected or unknown' })
    custodyReceivedAt!: string | null;

    @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'Moment the carrier marked "arrived at the warehouse". Shown only: it is not a collection and not the inventory receipt' })
    arrivedAtWarehouseAt!: string | null;
}

export class SupplierPickupComplianceDto {
    @ApiProperty({ type: String, format: 'date', description: 'First day of the range that was asked for' })
    from!: string;

    @ApiProperty({ type: String, format: 'date', description: 'Last day of the range that was asked for' })
    to!: string;

    @ApiProperty({ type: String, enum: ['appointment_window_end'], description: 'Date the range filters on: the end of the appointment window in force (without a valid window: closing time, else creation time)' })
    dateBasis!: 'appointment_window_end';

    @ApiProperty({ type: String, example: 'America/La_Paz', description: 'Time zone of the days of the range' })
    timeZone!: string;

    @ApiProperty({ type: String, format: 'date-time', description: 'Moment of the query; the cut that decides which appointments have expired' })
    asOf!: string;

    @ApiProperty({ type: ComplianceFiltersDto, description: 'The filters that were applied' })
    filters!: ComplianceFiltersDto;

    @ApiProperty({ type: ComplianceMetricsDto, description: 'The compliance rate with numerator, denominator and sample size' })
    metrics!: ComplianceMetricsDto;

    @ApiProperty({ type: ComplianceCountsDto, description: 'Every pickup of the range in exactly one category' })
    counts!: ComplianceCountsDto;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Non-cancelled pickups of the range that were rescheduled; they are measured against the window in force' })
    rescheduledCount!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Rescheduled pickups whose original window had already ended when they were first rescheduled. Shown apart from the rate' })
    originalExpiredBeforeRescheduleCount!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'All actionable exceptions of the range (`failed`, `openOverdue`, `late`, `unknownTiming`), even if the list is cut by `exceptionLimit`' })
    exceptionsTotal!: number;

    @ApiProperty({ type: [ComplianceExceptionDto], description: 'Actionable exceptions, the most overdue first, up to `exceptionLimit`' })
    exceptions!: ComplianceExceptionDto[];

    @ApiProperty({ type: Boolean, description: 'true when no pickup matches the filters ("no data")' })
    empty!: boolean;
}
