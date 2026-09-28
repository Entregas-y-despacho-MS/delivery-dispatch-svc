// RF-A33 — validación de los DTOs del catálogo de motivos de reprogramación/reasignación. Sin DB
// ni red: valida los DTOs directamente con class-validator, con las mismas opciones del
// ValidationPipe global. El comportamiento por HTTP (400, 409, nada guardado) se cubre en
// test/reschedule-reasons.e2e-spec.ts.
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateRescheduleReasonDto } from './create-reschedule-reason.dto.js';
import { UpdateRescheduleReasonDto } from './update-reschedule-reason.dto.js';
import { FindAllRescheduleReasonsParamsDto } from './find-all-reschedule-reasons-params.dto.js';
import { RescheduleReasonCategoryEnum } from '../../../../shared/enums/index.js';

const BASE = { code: 'RES-CLI-EXP', name: 'Solicitud expresa del cliente', description: 'El cliente pidió mover la entrega', category: RescheduleReasonCategoryEnum.CLIENT };
const OPTIONS = { whitelist: true, forbidNonWhitelisted: true };

async function errorsOf<T extends object>(cls: new () => T, plain: object): Promise<Record<string, string[]>> {
    const errors = await validate(plainToInstance(cls, plain), OPTIONS);
    return Object.fromEntries(errors.map((e) => [e.property, Object.keys(e.constraints ?? {})]));
}

// ── code ────────────────────────────────────────────────────────────────────────
describe('CreateRescheduleReasonDto — code', () => {
    it('se recorta y se pasa a mayúsculas', () => {
        expect(plainToInstance(CreateRescheduleReasonDto, { ...BASE, code: '  res-cli-exp  ' }).code).toBe('RES-CLI-EXP');
    });

    it.each(['', '   ', null, undefined, 123, true, [], {}])('rechaza code = %j', async (code) => {
        const plain: Record<string, unknown> = { ...BASE, code };
        if (code === undefined) delete plain.code;
        expect(Object.keys(await errorsOf(CreateRescheduleReasonDto, plain))).toEqual(['code']);
    });

    it('rechaza más de 30 caracteres, acepta exactamente 30', async () => {
        expect(Object.keys(await errorsOf(CreateRescheduleReasonDto, { ...BASE, code: 'A'.repeat(31) }))).toEqual(['code']);
        expect(await errorsOf(CreateRescheduleReasonDto, { ...BASE, code: 'A'.repeat(30) })).toEqual({});
    });
});

// ── name ────────────────────────────────────────────────────────────────────────
describe('CreateRescheduleReasonDto — name', () => {
    it('el ejemplo de la historia es válido: "Solicitud expresa del cliente", categoría cliente', async () => {
        expect(await errorsOf(CreateRescheduleReasonDto, BASE)).toEqual({});
    });

    it('el otro ejemplo de la historia: "Avería mecánica en ruta", fuerza_mayor', async () => {
        expect(await errorsOf(CreateRescheduleReasonDto, { code: 'RES-FM-AVE', name: 'Avería mecánica en ruta', category: RescheduleReasonCategoryEnum.FORCE_MAJEURE })).toEqual({});
    });

    it('se recorta', () => {
        expect(plainToInstance(CreateRescheduleReasonDto, { ...BASE, name: '  Solicitud expresa del cliente  ' }).name).toBe('Solicitud expresa del cliente');
    });

    it.each(['', '   ', null, undefined, 123, true, [], {}])('rechaza name = %j', async (name) => {
        const plain: Record<string, unknown> = { ...BASE, name };
        if (name === undefined) delete plain.name;
        expect(Object.keys(await errorsOf(CreateRescheduleReasonDto, plain))).toEqual(['name']);
    });

    it('rechaza más de 150 caracteres, acepta exactamente 150', async () => {
        expect(Object.keys(await errorsOf(CreateRescheduleReasonDto, { ...BASE, name: 'A'.repeat(151) }))).toEqual(['name']);
        expect(await errorsOf(CreateRescheduleReasonDto, { ...BASE, name: 'A'.repeat(150) })).toEqual({});
    });
});

// ── description ─────────────────────────────────────────────────────────────────
describe('CreateRescheduleReasonDto — description', () => {
    it('es opcional', async () => {
        const plain: Record<string, unknown> = { ...BASE };
        delete plain.description;
        expect(await errorsOf(CreateRescheduleReasonDto, plain)).toEqual({});
    });

    it('se recorta', () => {
        expect(plainToInstance(CreateRescheduleReasonDto, { ...BASE, description: '  detalle  ' }).description).toBe('detalle');
    });

    it('rechaza más de 255 caracteres, acepta exactamente 255', async () => {
        expect(Object.keys(await errorsOf(CreateRescheduleReasonDto, { ...BASE, description: 'A'.repeat(256) }))).toEqual(['description']);
        expect(await errorsOf(CreateRescheduleReasonDto, { ...BASE, description: 'A'.repeat(255) })).toEqual({});
    });

    it('rechaza un tipo que no sea texto', async () => {
        expect(Object.keys(await errorsOf(CreateRescheduleReasonDto, { ...BASE, description: 123 }))).toEqual(['description']);
    });
});

// ── category (Escenario 1 y 2) ────────────────────────────────────────────────
describe('CreateRescheduleReasonDto — category', () => {
    it.each(['client', 'operations', 'force_majeure'])('acepta %s', async (category) => {
        expect(await errorsOf(CreateRescheduleReasonDto, { ...BASE, category })).toEqual({});
    });

    it.each(['CLIENT', 'Operations', 'force majeure', 'forcemajeure', 'cliente', 'ninguna', '', null, undefined, 123, true, [], {}])('rechaza category = %j (no hay variantes, mayúsculas ni sinónimos, ni el español)', async (category) => {
        const plain: Record<string, unknown> = { ...BASE, category };
        if (category === undefined) delete plain.category;
        expect(Object.keys(await errorsOf(CreateRescheduleReasonDto, plain))).toEqual(['category']);
    });
});

describe('CreateRescheduleReasonDto — campos extra', () => {
    it('no se puede elegir el estado ni el id al crear', async () => {
        expect(Object.keys(await errorsOf(CreateRescheduleReasonDto, { ...BASE, active: false }))).toEqual(['active']);
        expect(Object.keys(await errorsOf(CreateRescheduleReasonDto, { ...BASE, id: 99 }))).toEqual(['id']);
    });
});

// ── UpdateRescheduleReasonDto ─────────────────────────────────────────────────
describe('UpdateRescheduleReasonDto', () => {
    it('un PUT vacío es válido (no-op)', async () => {
        expect(await errorsOf(UpdateRescheduleReasonDto, {})).toEqual({});
    });

    it.each(['code', 'name', 'category', 'active'])('null se rechaza en %s (NOT NULL)', async (field) => {
        expect(Object.keys(await errorsOf(UpdateRescheduleReasonDto, { [field]: null }))).toEqual([field]);
    });

    it('description sí acepta null: así se borra (columna nullable)', async () => {
        expect(await errorsOf(UpdateRescheduleReasonDto, { description: null })).toEqual({});
        expect(await errorsOf(UpdateRescheduleReasonDto, { description: '' })).toEqual({});
    });

    it('name vacío también se rechaza (no solo null)', async () => {
        expect(Object.keys(await errorsOf(UpdateRescheduleReasonDto, { name: '   ' }))).toEqual(['name']);
    });

    it('code vacío también se rechaza (no solo null), y se recorta/mayúscula cuando es válido', async () => {
        expect(Object.keys(await errorsOf(UpdateRescheduleReasonDto, { code: '   ' }))).toEqual(['code']);
        expect(plainToInstance(UpdateRescheduleReasonDto, { code: '  res-new  ' }).code).toBe('RES-NEW');
    });

    it('active debe ser un booleano de verdad, no la cadena "false"', async () => {
        expect(Object.keys(await errorsOf(UpdateRescheduleReasonDto, { active: 'false' }))).toEqual(['active']);
    });

    it('category solo acepta los 3 valores válidos', async () => {
        expect(await errorsOf(UpdateRescheduleReasonDto, { category: RescheduleReasonCategoryEnum.OPERATIONS })).toEqual({});
        expect(Object.keys(await errorsOf(UpdateRescheduleReasonDto, { category: 'otra' }))).toEqual(['category']);
    });

    it('se puede actualizar un solo campo', async () => {
        expect(await errorsOf(UpdateRescheduleReasonDto, { active: false })).toEqual({});
    });
});

// ── FindAllRescheduleReasonsParamsDto ─────────────────────────────────────────
describe('FindAllRescheduleReasonsParamsDto', () => {
    it('todo es opcional; paginación por defecto 1/10', () => {
        const dto = plainToInstance(FindAllRescheduleReasonsParamsDto, {});
        expect([dto.page, dto.limit]).toEqual([1, 10]);
    });

    it('active: "" se convierte a null (sin filtro); category no admite vacío, solo los 3 valores u omitirlo', () => {
        expect(plainToInstance(FindAllRescheduleReasonsParamsDto, { active: '' }).active).toBeNull();
        expect(() => plainToInstance(FindAllRescheduleReasonsParamsDto, { active: 'maybe' })).toThrow();
    });

    it('search se recorta y tiene un máximo de 100 caracteres', async () => {
        expect(plainToInstance(FindAllRescheduleReasonsParamsDto, { search: '  cliente  ' }).search).toBe('cliente');
        expect(Object.keys(await errorsOf(FindAllRescheduleReasonsParamsDto, { search: 'a'.repeat(101) }))).toEqual(['search']);
    });

    it('sortBy solo acepta code, name, category o createdAt', async () => {
        for (const sortBy of ['code', 'name', 'category', 'createdAt']) expect(await errorsOf(FindAllRescheduleReasonsParamsDto, { sortBy })).toEqual({});
        expect(Object.keys(await errorsOf(FindAllRescheduleReasonsParamsDto, { sortBy: 'active' }))).toEqual(['sortBy']);
    });

    it('sortOrder solo acepta asc/desc, sin distinguir mayúsculas', () => {
        expect(plainToInstance(FindAllRescheduleReasonsParamsDto, { sortOrder: 'DESC' }).sortOrder).toBe('desc');
    });

    it('category solo acepta los 3 valores válidos', async () => {
        expect(await errorsOf(FindAllRescheduleReasonsParamsDto, { category: 'force_majeure' })).toEqual({});
        expect(Object.keys(await errorsOf(FindAllRescheduleReasonsParamsDto, { category: 'otra' }))).toEqual(['category']);
    });

    it('un parámetro desconocido se rechaza', async () => {
        expect(Object.keys(await errorsOf(FindAllRescheduleReasonsParamsDto, { foo: 'bar' }))).toEqual(['foo']);
    });
});
