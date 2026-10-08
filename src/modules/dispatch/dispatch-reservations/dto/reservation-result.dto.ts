import { ApiProperty } from '@nestjs/swagger';

export class ReserveResultDto {
    @ApiProperty({ type: 'integer', example: 3, description: 'Orders now reserved for the coordinator (new or already theirs)' })
    reserved!: number;

    @ApiProperty({ type: String, format: 'date-time', description: 'When the reservation lapses if the coordinator stays inactive' })
    expiresAt!: Date;
}

export class RenewResultDto {
    @ApiProperty({ type: 'integer', example: 3, description: 'Live reservations that were renewed. Reservations that already lapsed are not brought back' })
    renewed!: number;

    @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'New expiry, or null when there was nothing to renew' })
    expiresAt!: Date | null;
}

export class ReleaseResultDto {
    @ApiProperty({ type: 'integer', example: 3, description: 'Reservations released' })
    released!: number;
}
