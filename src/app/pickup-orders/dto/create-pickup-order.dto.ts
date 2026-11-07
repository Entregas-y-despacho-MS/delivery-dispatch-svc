import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsDateString, IsEmail, IsInt, IsLatitude, IsLongitude, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** `null` or an empty string mean "not given" for an optional text. */
const trimOrNull = ({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const text = value.trim();
    return text === '' ? null : text;
};

const PHONE = /^\+?[0-9][0-9 ()-]{5,29}$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `POST /pickup-orders` (ST-81.2, RF-A39): a customer pickup the coordinator registers by hand. */
export class CreatePickupOrderDto {
    @ApiProperty({ type: String, maxLength: 30, example: 'WH-LPZ-01', description: 'Code of the warehouse that will receive the goods (`warehouses.code`). It must exist, be active and not be deleted' })
    @Transform(trim)
    @IsString({ message: 'warehouseCode must be a string.' })
    @IsNotEmpty({ message: 'warehouseCode must not be empty.' })
    @MaxLength(30, { message: 'warehouseCode must not be longer than 30 characters.' })
    warehouseCode!: string;

    @ApiProperty({ type: String, maxLength: 150, example: 'María Fernández Quispe', description: 'Name of the customer (or whoever hands over the goods)' })
    @Transform(trim)
    @IsString({ message: 'contactName must be a string.' })
    @IsNotEmpty({ message: 'contactName must not be empty.' })
    @MaxLength(150, { message: 'contactName must not be longer than 150 characters.' })
    contactName!: string;

    @ApiProperty({ type: String, maxLength: 30, example: '+59171234567', description: 'Phone of the customer: digits, optionally with a leading `+`, spaces, parentheses and hyphens (6 to 30 characters)' })
    @Transform(trim)
    @IsString({ message: 'contactPhone must be a string.' })
    @Matches(PHONE, { message: 'contactPhone must be a phone number of 6 to 30 characters: digits, optionally with +, spaces, parentheses and hyphens.' })
    contactPhone!: string;

    @ApiPropertyOptional({ type: String, maxLength: 150, nullable: true, example: 'maria.fernandez@example.com', description: 'Email of the customer; `null` or omitted means none' })
    @IsOptional()
    @Transform(trimOrNull)
    @IsEmail({}, { message: 'contactEmail must be a valid email.' })
    @MaxLength(150, { message: 'contactEmail must not be longer than 150 characters.' })
    contactEmail?: string | null;

    @ApiProperty({ type: String, maxLength: 300, example: 'Calle 21 de Calacoto 8790, casa 12', description: 'Address where the goods are picked up' })
    @Transform(trim)
    @IsString({ message: 'address must be a string.' })
    @IsNotEmpty({ message: 'address must not be empty.' })
    @MaxLength(300, { message: 'address must not be longer than 300 characters.' })
    address!: string;

    @ApiPropertyOptional({ type: String, maxLength: 300, nullable: true, example: 'Condominio Las Palmas, segunda garita', description: 'Extra directions to find the address; `null` or omitted means none' })
    @IsOptional()
    @Transform(trimOrNull)
    @IsString({ message: 'reference must be a string.' })
    @MaxLength(300, { message: 'reference must not be longer than 300 characters.' })
    reference?: string | null;

    @ApiProperty({ type: 'number', format: 'double', minimum: -90, maximum: 90, example: -16.5421, description: 'Latitude of the pickup point marked on the map, decimal degrees (WGS84). Required: the order starts in `pickup_scheduled`, ready to be planned' })
    @IsLatitude({ message: 'latitude must be a latitude between -90 and 90.' })
    latitude!: number;

    @ApiProperty({ type: 'number', format: 'double', minimum: -180, maximum: 180, example: -68.0802, description: 'Longitude of the pickup point marked on the map, decimal degrees (WGS84)' })
    @IsLongitude({ message: 'longitude must be a longitude between -180 and 180.' })
    longitude!: number;

    @ApiProperty({
        type: String, format: 'date', example: '2026-11-10',
        description: 'Day the customer prefers the pickup on, `YYYY-MM-DD` (Bolivia, America/La_Paz). It cannot be before today. The time slot is not chosen here: the planner assigns it when it builds the route batch',
    })
    @Matches(ISO_DAY, { message: 'preferredPickupDate must be a date in YYYY-MM-DD format.' })
    @IsDateString({ strict: true }, { message: 'preferredPickupDate must be a valid date in YYYY-MM-DD format.' })
    preferredPickupDate!: string;

    @ApiProperty({ type: String, maxLength: 500, example: '1 notebook with its charger, in the original box', description: 'Description of the goods to pick up' })
    @Transform(trim)
    @IsString({ message: 'packageContents must be a string.' })
    @IsNotEmpty({ message: 'packageContents must not be empty.' })
    @MaxLength(500, { message: 'packageContents must not be longer than 500 characters.' })
    packageContents!: string;

    @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 1000, nullable: true, example: 1, description: 'Estimated number of boxes, which counts toward the capacity of the route batch; `null` or omitted means not estimated' })
    @IsOptional()
    @IsInt({ message: 'estimatedBoxes must be a whole number.' })
    @Min(1, { message: 'estimatedBoxes must be at least 1.' })
    @Max(1000, { message: 'estimatedBoxes must be at most 1000.' })
    estimatedBoxes?: number | null;

    @ApiProperty({ type: String, maxLength: 500, example: 'Product with a power failure, within warranty', description: 'Why the goods are returned (free text, the same data an RMA brings); kept in `return_reason`' })
    @Transform(trim)
    @IsString({ message: 'returnReason must be a string.' })
    @IsNotEmpty({ message: 'returnReason must not be empty.' })
    @MaxLength(500, { message: 'returnReason must not be longer than 500 characters.' })
    returnReason!: string;

    @ApiPropertyOptional({ type: String, maxLength: 100, nullable: true, example: 'RMA-2026-0042', description: 'RMA this order refers to, when there is one. It is only kept in the audit event as a reference: it is not the order reference, so the RMA message that may arrive later does not collide with it; `null` or omitted means none' })
    @IsOptional()
    @Transform(trimOrNull)
    @IsString({ message: 'rmaId must be a string.' })
    @MaxLength(100, { message: 'rmaId must not be longer than 100 characters.' })
    rmaId?: string | null;
}
