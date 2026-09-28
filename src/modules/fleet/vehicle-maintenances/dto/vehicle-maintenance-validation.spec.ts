// RF-A34 — validación del DTO de alta de vehicle-maintenances. Sin DB ni red. El comportamiento por
// HTTP (incl. la transición de estado del vehículo) se cubre en test/vehicle-maintenances.e2e-spec.ts.
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateVehicleMaintenanceDto } from './create-vehicle-maintenance.dto.js';

const BASE = { vehicleId: 7, vehicleIncidentTypeId: 3, description: 'Se sintió ruido metálico en las pastillas de freno delanteras' };
const OPTIONS = { whitelist: true, forbidNonWhitelisted: true };

async function errorsOf<T extends object>(cls: new () => T, plain: object): Promise<Record<string, string[]>> {
    const errors = await validate(plainToInstance(cls, plain), OPTIONS);
    return Object.fromEntries(errors.map((e) => [e.property, Object.keys(e.constraints ?? {})]));
}

describe('CreateVehicleMaintenanceDto — vehicleId', () => {
    it('el body válido no tiene errores', async () => {
        expect(await errorsOf(CreateVehicleMaintenanceDto, BASE)).toEqual({});
    });

    it.each([0, -1, 1.5, 'abc', null, undefined, 2_147_483_648])('rechaza vehicleId = %j', async (vehicleId) => {
        const plain: Record<string, unknown> = { ...BASE, vehicleId };
        if (vehicleId === undefined) delete plain.vehicleId;
        expect(Object.keys(await errorsOf(CreateVehicleMaintenanceDto, plain))).toEqual(['vehicleId']);
    });
});

describe('CreateVehicleMaintenanceDto — vehicleIncidentTypeId', () => {
    it.each([0, -1, 1.5, 'abc', null, undefined, 2_147_483_648])('rechaza vehicleIncidentTypeId = %j (obligatorio en este endpoint, a diferencia de la columna)', async (vehicleIncidentTypeId) => {
        const plain: Record<string, unknown> = { ...BASE, vehicleIncidentTypeId };
        if (vehicleIncidentTypeId === undefined) delete plain.vehicleIncidentTypeId;
        expect(Object.keys(await errorsOf(CreateVehicleMaintenanceDto, plain))).toEqual(['vehicleIncidentTypeId']);
    });
});

describe('CreateVehicleMaintenanceDto — description', () => {
    it('se recorta', () => {
        expect(plainToInstance(CreateVehicleMaintenanceDto, { ...BASE, description: '  detalle  ' }).description).toBe('detalle');
    });

    it.each(['', '   ', null, undefined, 123])('rechaza description = %j', async (description) => {
        const plain: Record<string, unknown> = { ...BASE, description };
        if (description === undefined) delete plain.description;
        expect(Object.keys(await errorsOf(CreateVehicleMaintenanceDto, plain))).toEqual(['description']);
    });

    it('rechaza más de 1000 caracteres, acepta exactamente 1000', async () => {
        expect(Object.keys(await errorsOf(CreateVehicleMaintenanceDto, { ...BASE, description: 'A'.repeat(1001) }))).toEqual(['description']);
        expect(await errorsOf(CreateVehicleMaintenanceDto, { ...BASE, description: 'A'.repeat(1000) })).toEqual({});
    });
});

describe('CreateVehicleMaintenanceDto — campos extra', () => {
    it('no se puede elegir el estado ni el id al crear (eso lo decide el trigger, no el body)', async () => {
        expect(Object.keys(await errorsOf(CreateVehicleMaintenanceDto, { ...BASE, status: 'completed' }))).toEqual(['status']);
        expect(Object.keys(await errorsOf(CreateVehicleMaintenanceDto, { ...BASE, id: 99 }))).toEqual(['id']);
    });
});
