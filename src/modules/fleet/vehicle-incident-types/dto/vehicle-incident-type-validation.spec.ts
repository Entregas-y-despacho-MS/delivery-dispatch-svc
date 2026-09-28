// RF-A34 — validación de los DTOs del catálogo de tipos de incidente vehicular. Sin DB ni red:
// valida los DTOs directamente con class-validator, con las mismas opciones del ValidationPipe
// global. El comportamiento por HTTP se cubre en test/vehicle-incident-types.e2e-spec.ts.
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateVehicleIncidentTypeDto } from './create-vehicle-incident-type.dto.js';
import { UpdateVehicleIncidentTypeDto } from './update-vehicle-incident-type.dto.js';
import { FindAllVehicleIncidentTypesParamsDto } from './find-all-vehicle-incident-types-params.dto.js';
import { VehicleIncidentSeverityEnum } from '../../../../shared/enums/index.js';

const BASE = { code: 'MEC-FRE-01', name: 'Falla en sistema de frenos', severity: VehicleIncidentSeverityEnum.CRITICAL, disablesVehicle: true };
const OPTIONS = { whitelist: true, forbidNonWhitelisted: true };

async function errorsOf<T extends object>(cls: new () => T, plain: object): Promise<Record<string, string[]>> {
    const errors = await validate(plainToInstance(cls, plain), OPTIONS);
    return Object.fromEntries(errors.map((e) => [e.property, Object.keys(e.constraints ?? {})]));
}

// ── code ────────────────────────────────────────────────────────────────────────
describe('CreateVehicleIncidentTypeDto — code', () => {
    it('el ejemplo de la historia es válido: MEC-FRE-01, "Falla en sistema de frenos", crítica, inhabilita', async () => {
        expect(await errorsOf(CreateVehicleIncidentTypeDto, BASE)).toEqual({});
    });

    it('se recorta y se pasa a mayúsculas', () => {
        expect(plainToInstance(CreateVehicleIncidentTypeDto, { ...BASE, code: '  mec-fre-01  ' }).code).toBe('MEC-FRE-01');
    });

    it.each(['', '   ', null, undefined, 123, true, [], {}])('rechaza code = %j', async (code) => {
        const plain: Record<string, unknown> = { ...BASE, code };
        if (code === undefined) delete plain.code;
        expect(Object.keys(await errorsOf(CreateVehicleIncidentTypeDto, plain))).toEqual(['code']);
    });

    it('rechaza más de 30 caracteres, acepta exactamente 30', async () => {
        expect(Object.keys(await errorsOf(CreateVehicleIncidentTypeDto, { ...BASE, code: 'A'.repeat(31) }))).toEqual(['code']);
        expect(await errorsOf(CreateVehicleIncidentTypeDto, { ...BASE, code: 'A'.repeat(30) })).toEqual({});
    });
});

// ── name ────────────────────────────────────────────────────────────────────────
describe('CreateVehicleIncidentTypeDto — name', () => {
    it('se recorta', () => {
        expect(plainToInstance(CreateVehicleIncidentTypeDto, { ...BASE, name: '  Falla en sistema de frenos  ' }).name).toBe('Falla en sistema de frenos');
    });

    it.each(['', '   ', null, undefined, 123, true, [], {}])('rechaza name = %j', async (name) => {
        const plain: Record<string, unknown> = { ...BASE, name };
        if (name === undefined) delete plain.name;
        expect(Object.keys(await errorsOf(CreateVehicleIncidentTypeDto, plain))).toEqual(['name']);
    });

    it('rechaza más de 100 caracteres, acepta exactamente 100', async () => {
        expect(Object.keys(await errorsOf(CreateVehicleIncidentTypeDto, { ...BASE, name: 'A'.repeat(101) }))).toEqual(['name']);
        expect(await errorsOf(CreateVehicleIncidentTypeDto, { ...BASE, name: 'A'.repeat(100) })).toEqual({});
    });
});

// ── severity (Escenario 3) ────────────────────────────────────────────────────
describe('CreateVehicleIncidentTypeDto — severity', () => {
    it.each(['minor', 'moderate', 'critical'])('acepta %s', async (severity) => {
        expect(await errorsOf(CreateVehicleIncidentTypeDto, { ...BASE, severity })).toEqual({});
    });

    it.each(['CRITICAL', 'Moderate', 'leve', 'moderada', 'crítica', 'critica', 'ninguna', '', null, undefined, 123, true, [], {}])('rechaza severity = %j (no hay variantes, mayúsculas ni el español)', async (severity) => {
        const plain: Record<string, unknown> = { ...BASE, severity };
        if (severity === undefined) delete plain.severity;
        expect(Object.keys(await errorsOf(CreateVehicleIncidentTypeDto, plain))).toEqual(['severity']);
    });
});

// ── disablesVehicle ────────────────────────────────────────────────────────────
describe('CreateVehicleIncidentTypeDto — disablesVehicle', () => {
    it.each([true, false])('acepta %s', async (disablesVehicle) => {
        expect(await errorsOf(CreateVehicleIncidentTypeDto, { ...BASE, disablesVehicle })).toEqual({});
    });

    it.each(['true', 'false', 1, 0, null, undefined, 'si', [], {}])('rechaza disablesVehicle = %j (booleano real, no string/número)', async (disablesVehicle) => {
        const plain: Record<string, unknown> = { ...BASE, disablesVehicle };
        if (disablesVehicle === undefined) delete plain.disablesVehicle;
        expect(Object.keys(await errorsOf(CreateVehicleIncidentTypeDto, plain))).toEqual(['disablesVehicle']);
    });
});

describe('CreateVehicleIncidentTypeDto — campos extra', () => {
    it('no se puede elegir el id al crear', async () => {
        expect(Object.keys(await errorsOf(CreateVehicleIncidentTypeDto, { ...BASE, id: 99 }))).toEqual(['id']);
    });
});

// ── UpdateVehicleIncidentTypeDto ─────────────────────────────────────────────
describe('UpdateVehicleIncidentTypeDto', () => {
    it('un PUT vacío es válido (no-op)', async () => {
        expect(await errorsOf(UpdateVehicleIncidentTypeDto, {})).toEqual({});
    });

    it.each(['code', 'name', 'severity', 'disablesVehicle'])('null se rechaza en %s (NOT NULL)', async (field) => {
        expect(Object.keys(await errorsOf(UpdateVehicleIncidentTypeDto, { [field]: null }))).toEqual([field]);
    });

    it('se puede actualizar un solo campo', async () => {
        expect(await errorsOf(UpdateVehicleIncidentTypeDto, { disablesVehicle: false })).toEqual({});
    });

    it('severity solo acepta los 3 valores válidos', async () => {
        expect(await errorsOf(UpdateVehicleIncidentTypeDto, { severity: VehicleIncidentSeverityEnum.MINOR })).toEqual({});
        expect(Object.keys(await errorsOf(UpdateVehicleIncidentTypeDto, { severity: 'otra' }))).toEqual(['severity']);
    });
});

// ── FindAllVehicleIncidentTypesParamsDto ─────────────────────────────────────
describe('FindAllVehicleIncidentTypesParamsDto', () => {
    it('todo es opcional; paginación por defecto 1/10', () => {
        const dto = plainToInstance(FindAllVehicleIncidentTypesParamsDto, {});
        expect([dto.page, dto.limit]).toEqual([1, 10]);
    });

    it('disablesVehicle: "" se convierte a null (sin filtro); severity no admite vacío, solo los 3 valores u omitirlo', () => {
        expect(plainToInstance(FindAllVehicleIncidentTypesParamsDto, { disablesVehicle: '' }).disablesVehicle).toBeNull();
        expect(() => plainToInstance(FindAllVehicleIncidentTypesParamsDto, { disablesVehicle: 'maybe' })).toThrow();
    });

    it('sortBy solo acepta code, name, severity o createdAt', async () => {
        for (const sortBy of ['code', 'name', 'severity', 'createdAt']) expect(await errorsOf(FindAllVehicleIncidentTypesParamsDto, { sortBy })).toEqual({});
        expect(Object.keys(await errorsOf(FindAllVehicleIncidentTypesParamsDto, { sortBy: 'disablesVehicle' }))).toEqual(['sortBy']);
    });

    it('un parámetro desconocido se rechaza', async () => {
        expect(Object.keys(await errorsOf(FindAllVehicleIncidentTypesParamsDto, { foo: 'bar' }))).toEqual(['foo']);
    });
});
