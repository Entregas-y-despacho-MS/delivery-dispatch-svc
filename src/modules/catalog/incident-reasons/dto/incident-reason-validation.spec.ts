// RF-A32 — validación de los DTOs del catálogo de motivos de incidencia. Sin DB ni red: valida los
// DTOs directamente con class-validator, con las mismas opciones del ValidationPipe global. El
// comportamiento por HTTP (400, 409, nada guardado) se cubre en test/incident-reasons.e2e-spec.ts.
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateIncidentReasonDto } from './create-incident-reason.dto.js';
import { UpdateIncidentReasonDto } from './update-incident-reason.dto.js';
import { FindAllIncidentReasonsParamsDto } from './find-all-incident-reasons-params.dto.js';

const BASE = { code: 'INC-CLI-AUS', name: 'Cliente ausente', requiresEvidence: true };
const OPTIONS = { whitelist: true, forbidNonWhitelisted: true };

async function errorsOf<T extends object>(cls: new () => T, plain: object): Promise<Record<string, string[]>> {
    const errors = await validate(plainToInstance(cls, plain), OPTIONS);
    return Object.fromEntries(errors.map((e) => [e.property, Object.keys(e.constraints ?? {})]));
}

// ── code ────────────────────────────────────────────────────────────────────────
describe('CreateIncidentReasonDto — code', () => {
    it('el ejemplo de la historia es válido: "INC-CLI-AUS", "Cliente ausente", requiere foto', async () => {
        expect(await errorsOf(CreateIncidentReasonDto, BASE)).toEqual({});
    });

    it('se recorta y se pasa a mayúsculas antes de validar', () => {
        const dto = plainToInstance(CreateIncidentReasonDto, { ...BASE, code: '  inc-cli-aus  ' });
        expect(dto.code).toBe('INC-CLI-AUS');
    });

    it.each(['', '   ', null, undefined, 123, true, [], {}])('rechaza code = %j', async (code) => {
        const errors = await errorsOf(CreateIncidentReasonDto, { ...BASE, code });
        expect(Object.keys(errors)).toEqual(['code']);
    });

    it('rechaza más de 30 caracteres, acepta exactamente 30', async () => {
        expect(Object.keys(await errorsOf(CreateIncidentReasonDto, { ...BASE, code: 'A'.repeat(31) }))).toEqual(['code']);
        expect(await errorsOf(CreateIncidentReasonDto, { ...BASE, code: 'A'.repeat(30) })).toEqual({});
    });
});

// ── name ────────────────────────────────────────────────────────────────────────
describe('CreateIncidentReasonDto — name', () => {
    it('se recorta', () => {
        expect(plainToInstance(CreateIncidentReasonDto, { ...BASE, name: '  Cliente ausente  ' }).name).toBe('Cliente ausente');
    });

    it.each(['', '   ', null, undefined, 123, true, [], {}])('rechaza name = %j', async (name) => {
        expect(Object.keys(await errorsOf(CreateIncidentReasonDto, { ...BASE, name }))).toEqual(['name']);
    });

    it('rechaza más de 150 caracteres, acepta exactamente 150', async () => {
        expect(Object.keys(await errorsOf(CreateIncidentReasonDto, { ...BASE, name: 'A'.repeat(151) }))).toEqual(['name']);
        expect(await errorsOf(CreateIncidentReasonDto, { ...BASE, name: 'A'.repeat(150) })).toEqual({});
    });
});

// ── requiresEvidence ──────────────────────────────────────────────────────────
describe('CreateIncidentReasonDto — requiresEvidence', () => {
    it('acepta true y false', async () => {
        expect(await errorsOf(CreateIncidentReasonDto, { ...BASE, requiresEvidence: true })).toEqual({});
        expect(await errorsOf(CreateIncidentReasonDto, { ...BASE, requiresEvidence: false })).toEqual({});
    });

    it.each([null, undefined, 'true', 1, 0, [], {}])('rechaza requiresEvidence = %j (es obligatorio y debe ser booleano real)', async (value) => {
        const plain: Record<string, unknown> = { ...BASE, requiresEvidence: value };
        if (value === undefined) delete plain.requiresEvidence;
        expect(Object.keys(await errorsOf(CreateIncidentReasonDto, plain))).toEqual(['requiresEvidence']);
    });
});

describe('CreateIncidentReasonDto — campos extra', () => {
    it('no se puede elegir el estado ni el id al crear', async () => {
        expect(Object.keys(await errorsOf(CreateIncidentReasonDto, { ...BASE, active: false }))).toEqual(['active']);
        expect(Object.keys(await errorsOf(CreateIncidentReasonDto, { ...BASE, id: 99 }))).toEqual(['id']);
    });
});

// ── UpdateIncidentReasonDto ───────────────────────────────────────────────────
describe('UpdateIncidentReasonDto', () => {
    it('un PUT vacío es válido (no-op)', async () => {
        expect(await errorsOf(UpdateIncidentReasonDto, {})).toEqual({});
    });

    it.each(['code', 'name', 'requiresEvidence', 'active'])('null se rechaza en %s (todos son NOT NULL)', async (field) => {
        expect(Object.keys(await errorsOf(UpdateIncidentReasonDto, { [field]: null }))).toEqual([field]);
    });

    it('code y name vacíos también se rechazan (no solo null)', async () => {
        expect(Object.keys(await errorsOf(UpdateIncidentReasonDto, { code: '' }))).toEqual(['code']);
        expect(Object.keys(await errorsOf(UpdateIncidentReasonDto, { name: '   ' }))).toEqual(['name']);
    });

    it('active debe ser un booleano de verdad, no la cadena "false"', async () => {
        expect(Object.keys(await errorsOf(UpdateIncidentReasonDto, { active: 'false' }))).toEqual(['active']);
    });

    it('se puede actualizar un solo campo', async () => {
        expect(await errorsOf(UpdateIncidentReasonDto, { active: false })).toEqual({});
        expect(await errorsOf(UpdateIncidentReasonDto, { requiresEvidence: true })).toEqual({});
    });
});

// ── FindAllIncidentReasonsParamsDto ───────────────────────────────────────────
describe('FindAllIncidentReasonsParamsDto', () => {
    it('todo es opcional; paginación por defecto 1/10', () => {
        const dto = plainToInstance(FindAllIncidentReasonsParamsDto, {});
        expect([dto.page, dto.limit]).toEqual([1, 10]);
    });

    it('active y requiresEvidence: "" se convierte a null (sin filtro)', () => {
        expect(plainToInstance(FindAllIncidentReasonsParamsDto, { active: '' }).active).toBeNull();
        expect(plainToInstance(FindAllIncidentReasonsParamsDto, { requiresEvidence: '' }).requiresEvidence).toBeNull();
    });

    it('un valor no-booleano (ni true/false ni vacío) lanza al transformar, no un 500 silencioso', () => {
        expect(() => plainToInstance(FindAllIncidentReasonsParamsDto, { active: 'maybe' })).toThrow();
        expect(() => plainToInstance(FindAllIncidentReasonsParamsDto, { requiresEvidence: 'maybe' })).toThrow();
    });

    it('search se recorta y tiene un máximo de 100 caracteres', async () => {
        expect(plainToInstance(FindAllIncidentReasonsParamsDto, { search: '  absent  ' }).search).toBe('absent');
        expect(Object.keys(await errorsOf(FindAllIncidentReasonsParamsDto, { search: 'a'.repeat(101) }))).toEqual(['search']);
    });

    it('sortBy solo acepta name, code o createdAt', async () => {
        for (const sortBy of ['name', 'code', 'createdAt']) expect(await errorsOf(FindAllIncidentReasonsParamsDto, { sortBy })).toEqual({});
        expect(Object.keys(await errorsOf(FindAllIncidentReasonsParamsDto, { sortBy: 'active' }))).toEqual(['sortBy']);
    });

    it('sortOrder solo acepta asc/desc, sin distinguir mayúsculas', () => {
        expect(plainToInstance(FindAllIncidentReasonsParamsDto, { sortOrder: 'DESC' }).sortOrder).toBe('desc');
    });

    it('un parámetro desconocido se rechaza', async () => {
        expect(Object.keys(await errorsOf(FindAllIncidentReasonsParamsDto, { foo: 'bar' }))).toEqual(['foo']);
    });
});
