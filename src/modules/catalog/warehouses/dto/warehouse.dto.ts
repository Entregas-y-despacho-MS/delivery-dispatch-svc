import { ApiProperty } from '@nestjs/swagger';
import { DtoField } from '../../../../shared/orm/index.js';

export class WarehouseDto {
    @DtoField()
    @ApiProperty({ type: 'integer', example: 1, description: 'Warehouse ID' })
    id!: number;

    @DtoField()
    @ApiProperty({ example: 'WH-LPZ-01', description: 'Unique reference code' })
    code!: string;

    @DtoField()
    @ApiProperty({ example: 'Centro de Distribución La Paz', description: 'Display name' })
    name!: string;

    @DtoField()
    @ApiProperty({ example: 'Av. Autopista Viacha, Zona Industrial, La Paz', description: 'Physical address' })
    address!: string;

    @DtoField()
    @ApiProperty({ type: 'number', format: 'double', example: -16.52, description: 'Latitude — used as the route origin for OSRM when this warehouse is the dispatch point' })
    latitude!: number;

    @DtoField()
    @ApiProperty({ type: 'number', format: 'double', example: -68.169, description: 'Longitude — used as the route origin for OSRM when this warehouse is the dispatch point' })
    longitude!: number;

    @DtoField()
    @ApiProperty({ type: String, example: 'Operaciones CD La Paz', nullable: true, description: 'Contact person at the warehouse. null when none is set' })
    contactName!: string | null;

    @DtoField()
    @ApiProperty({ type: String, example: '+591 2 2345678', nullable: true, description: 'Contact phone number. null when none is set' })
    contactPhone!: string | null;

    @DtoField()
    @ApiProperty({ example: '07:00:00', description: 'Start of the time window in which the warehouse receives cargo (HH:mm:ss)' })
    receptionStartTime!: string;

    @DtoField()
    @ApiProperty({ example: '19:00:00', description: 'End of the time window in which the warehouse receives cargo (HH:mm:ss)' })
    receptionEndTime!: string;

    @DtoField()
    @ApiProperty({ example: true, description: 'false = disabled: cannot be used as origin/destination for new dispatches' })
    active!: boolean;
}
