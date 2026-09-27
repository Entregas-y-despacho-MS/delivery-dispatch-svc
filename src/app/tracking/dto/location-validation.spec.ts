// RF-U11 — validación de los DTOs del reporte de ubicación. Sin DB ni red: valida los DTOs
// directamente con class-validator, con las mismas opciones del ValidationPipe global. El
// comportamiento por HTTP se cubre en test/tracking.e2e-spec.ts.
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LocationPointDto } from './location-point.dto.js';
import { ReportLocationsDto } from './report-locations.dto.js';

const BASE_POINT = { dispatchId: 42, latitude: -17.783, longitude: -63.182, recordedAt: new Date().toISOString() };
const OPTIONS = { whitelist: true, forbidNonWhitelisted: true };

async function errorsOf<T extends object>(cls: new () => T, plain: object): Promise<Record<string, string[]>> {
    const errors = await validate(plainToInstance(cls, plain), OPTIONS);
    return Object.fromEntries(errors.map((e) => [e.property, Object.keys(e.constraints ?? {})]));
}

describe('LocationPointDto — dispatchId', () => {
    it('el ejemplo válido no tiene errores', async () => {
        expect(await errorsOf(LocationPointDto, BASE_POINT)).toEqual({});
    });

    it.each([0, -1, 1.5, 'abc', null, undefined, 2_147_483_648])('rechaza dispatchId = %j', async (dispatchId) => {
        const plain: Record<string, unknown> = { ...BASE_POINT, dispatchId };
        if (dispatchId === undefined) delete plain.dispatchId;
        expect(Object.keys(await errorsOf(LocationPointDto, plain))).toEqual(['dispatchId']);
    });
});

describe('LocationPointDto — latitude/longitude', () => {
    it.each([90, -90, 0, 45.123456])('acepta latitude = %j (rango válido)', async (latitude) => {
        expect(await errorsOf(LocationPointDto, { ...BASE_POINT, latitude })).toEqual({});
    });

    it.each([90.0001, -90.0001, 180, -180, 'abc', null])('rechaza latitude = %j (fuera de -90..90, o no es un número)', async (latitude) => {
        expect(Object.keys(await errorsOf(LocationPointDto, { ...BASE_POINT, latitude }))).toEqual(['latitude']);
    });

    it.each([180, -180, 0, 63.182])('acepta longitude = %j (rango válido)', async (longitude) => {
        expect(await errorsOf(LocationPointDto, { ...BASE_POINT, longitude })).toEqual({});
    });

    it.each([180.0001, -180.0001, 'abc', null])('rechaza longitude = %j (fuera de -180..180, o no es un número)', async (longitude) => {
        expect(Object.keys(await errorsOf(LocationPointDto, { ...BASE_POINT, longitude }))).toEqual(['longitude']);
    });
});

describe('LocationPointDto — recordedAt', () => {
    // Un string solo-fecha ("2026-09-29", sin hora) SÍ pasa @IsDateString() — mismo comportamiento
    // ya aceptado en SyncEventDto.occurredAt, no una laxitud nueva de este DTO.
    it.each(['not-a-date', 123, null, undefined])('rechaza recordedAt = %j (debe ser una fecha ISO 8601 válida)', async (recordedAt) => {
        const plain: Record<string, unknown> = { ...BASE_POINT, recordedAt };
        if (recordedAt === undefined) delete plain.recordedAt;
        expect(Object.keys(await errorsOf(LocationPointDto, plain))).toEqual(['recordedAt']);
    });

    it('una fecha futura NO se rechaza acá — eso lo decide TrackingService, no el DTO', async () => {
        const farFuture = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        expect(await errorsOf(LocationPointDto, { ...BASE_POINT, recordedAt: farFuture })).toEqual({});
    });
});

describe('LocationPointDto — campos extra', () => {
    it('no se puede mandar un id propio del punto ni un active', async () => {
        expect(Object.keys(await errorsOf(LocationPointDto, { ...BASE_POINT, id: 1 }))).toEqual(['id']);
    });
});

describe('ReportLocationsDto', () => {
    it('un array con un punto válido no tiene errores', async () => {
        expect(await errorsOf(ReportLocationsDto, { locations: [BASE_POINT] })).toEqual({});
    });

    it('un array con varios puntos válidos no tiene errores', async () => {
        expect(await errorsOf(ReportLocationsDto, { locations: [BASE_POINT, { ...BASE_POINT, dispatchId: 43 }] })).toEqual({});
    });

    it('rechaza un array vacío', async () => {
        expect(Object.keys(await errorsOf(ReportLocationsDto, { locations: [] }))).toEqual(['locations']);
    });

    it('rechaza que falte locations, o que no sea un array', async () => {
        expect(Object.keys(await errorsOf(ReportLocationsDto, {}))).toEqual(['locations']);
        expect(Object.keys(await errorsOf(ReportLocationsDto, { locations: 'x' }))).toEqual(['locations']);
    });

    it('un punto inválido dentro del array se reporta (nested validation), sin importar cuál de los varios lo sea', async () => {
        const errors = await errorsOf(ReportLocationsDto, { locations: [BASE_POINT, { ...BASE_POINT, latitude: 999 }] });
        expect(Object.keys(errors)).toEqual(['locations']);
    });
});
