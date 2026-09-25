// ST-23.3 — validación de los DTOs de niveles de servicio (RF-A31, Escenario 2: tiempos objetivo
// coherentes). Sin DB ni red: valida los DTOs directamente con class-validator, con las mismas
// opciones del ValidationPipe global. El comportamiento por HTTP (400, nada guardado) se cubre en
// test/service-levels.e2e-spec.ts.
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateServiceLevelDto } from './create-service-level.dto.js';
import { UpdateServiceLevelDto } from './update-service-level.dto.js';
import { FindAllServiceLevelsParamsDto } from './find-all-service-levels-params.dto.js';
import { MAX_PRIORITY_LEVEL, MAX_TARGET_TIME_MIN, MIN_TARGET_TIME_MIN } from './service-level-limits.js';

const BASE = { name: 'Express 2 Horas', description: 'Entrega en 2 horas', targetTimeMin: 120, priorityLevel: 1 };
const OPTIONS = { whitelist: true, forbidNonWhitelisted: true };

async function errorsOf<T extends object>(cls: new () => T, plain: object): Promise<Record<string, string[]>> {
    const errors = await validate(plainToInstance(cls, plain), OPTIONS);
    return Object.fromEntries(errors.map((e) => [e.property, Object.keys(e.constraints ?? {})]));
}

describe('límites del negocio (RF-A31)', () => {
    it('el tiempo objetivo mínimo es de 15 minutos', () => {
        expect(MIN_TARGET_TIME_MIN).toBe(15);
    });
    it('el máximo de tiempo (30 días) y de prioridad (SMALLINT) quedan dentro de lo que soporta la base', () => {
        expect(MAX_TARGET_TIME_MIN).toBe(43200);
        expect(MAX_PRIORITY_LEVEL).toBe(32767);
    });
});

// ── tiempo objetivo ────────────────────────────────────────────────────────────
const BAD_TARGET_TIME: [label: string, value: unknown, expectedConstraint: string][] = [
    ['14 minutos (justo bajo el mínimo)', 14,        'min'],
    ['cero',                              0,         'min'],
    ['negativo',                          -1,        'min'],
    ['14.9 (bajo el mínimo y decimal)',   14.9,      'isInt'],
    ['15.5 (decimal aunque supere 15)',   15.5,      'isInt'],
    ['texto numérico',                    '120',     'isInt'],
    ['texto',                             'abc',     'isInt'],
    ['null',                              null,      'isInt'],
    ['booleano',                          true,      'isInt'],
    ['array',                             [],        'isInt'],
    ['objeto',                            {},        'isInt'],
    ['NaN',                               Number.NaN, 'isInt'],
    ['Infinity',                          Infinity,  'isInt'],
    ['sobre el máximo (43201)',           43201,     'max'],
    ['muy por encima del máximo',         1e9,       'max'],
];
const GOOD_TARGET_TIME: [label: string, value: number][] = [
    ['el mínimo (15)', 15], ['16', 16], ['120 (el ejemplo de la historia)', 120], ['un día (1440)', 1440], ['el máximo (43200)', 43200],
];

describe('CreateServiceLevelDto — tiempo objetivo (RF-A31, Escenario 2)', () => {
    it('el ejemplo de la historia es válido: "Express 2 Horas", 120 min, prioridad alta', async () => {
        expect(await errorsOf(CreateServiceLevelDto, BASE)).toEqual({});
    });

    for (const [label, value, constraint] of BAD_TARGET_TIME) {
        it(`rechaza ${label}`, async () => {
            const errors = await errorsOf(CreateServiceLevelDto, { ...BASE, targetTimeMin: value });
            expect(Object.keys(errors)).toEqual(['targetTimeMin']); // solo ese campo falla
            expect(errors.targetTimeMin).toContain(constraint);
        });
    }

    for (const [label, value] of GOOD_TARGET_TIME) {
        it(`acepta ${label}`, async () => {
            expect(await errorsOf(CreateServiceLevelDto, { ...BASE, targetTimeMin: value })).toEqual({});
        });
    }

    it('es obligatorio (faltante)', async () => {
        const { targetTimeMin: _omitted, ...rest } = BASE;
        expect(Object.keys(await errorsOf(CreateServiceLevelDto, rest))).toEqual(['targetTimeMin']);
    });

    it('el mensaje de un tiempo menor al mínimo nombra los 15 minutos', async () => {
        const errors = await validate(plainToInstance(CreateServiceLevelDto, { ...BASE, targetTimeMin: 10 }), OPTIONS);
        const messages = errors.flatMap((e) => Object.values(e.constraints ?? {}));
        expect(messages).toContain('Target time must be at least 15 minutes.');
    });
});

// ── prioridad, nombre y descripción ────────────────────────────────────────────
describe('CreateServiceLevelDto — prioridad', () => {
    for (const [label, value] of [['cero', 0], ['negativa', -1], ['decimal', 1.5], ['texto', '1'], ['null', null], ['NaN', Number.NaN], ['sobre el máximo (SMALLINT)', 32768]] as const) {
        it(`rechaza ${label}`, async () => {
            expect(Object.keys(await errorsOf(CreateServiceLevelDto, { ...BASE, priorityLevel: value }))).toEqual(['priorityLevel']);
        });
    }
    for (const value of [1, 2, 10, 32767]) {
        it(`acepta ${value}`, async () => {
            expect(await errorsOf(CreateServiceLevelDto, { ...BASE, priorityLevel: value })).toEqual({});
        });
    }
    it('es obligatoria (faltante)', async () => {
        const { priorityLevel: _omitted, ...rest } = BASE;
        expect(Object.keys(await errorsOf(CreateServiceLevelDto, rest))).toEqual(['priorityLevel']);
    });
});

describe('CreateServiceLevelDto — nombre y descripción', () => {
    it('recorta los espacios del nombre y de la descripción', () => {
        const dto = plainToInstance(CreateServiceLevelDto, { ...BASE, name: '  Express  ', description: '  rápido  ' });
        expect(dto.name).toBe('Express');
        expect(dto.description).toBe('rápido');
    });

    it('un nombre vacío, de solo espacios o faltante se rechaza; hasta 50 caracteres se acepta', async () => {
        expect((await errorsOf(CreateServiceLevelDto, { ...BASE, name: '' })).name).toContain('isNotEmpty');
        expect((await errorsOf(CreateServiceLevelDto, { ...BASE, name: '     ' })).name).toContain('isNotEmpty');
        expect((await errorsOf(CreateServiceLevelDto, { ...BASE, name: 'N'.repeat(51) })).name).toContain('maxLength');
        expect(await errorsOf(CreateServiceLevelDto, { ...BASE, name: 'N'.repeat(50) })).toEqual({});
        const { name: _omitted, ...rest } = BASE;
        expect(Object.keys(await errorsOf(CreateServiceLevelDto, rest))).toEqual(['name']);
    });

    it('la descripción es opcional; hasta 255 caracteres, más se rechaza; debe ser texto', async () => {
        const { description: _omitted, ...rest } = BASE;
        expect(await errorsOf(CreateServiceLevelDto, rest)).toEqual({});
        expect(await errorsOf(CreateServiceLevelDto, { ...BASE, description: 'D'.repeat(255) })).toEqual({});
        expect((await errorsOf(CreateServiceLevelDto, { ...BASE, description: 'D'.repeat(256) })).description).toContain('maxLength');
        expect((await errorsOf(CreateServiceLevelDto, { ...BASE, description: 123 })).description).toContain('isString');
    });

    it('no acepta campos que no son del alta: el estado (active) ni el id', async () => {
        expect(Object.keys(await errorsOf(CreateServiceLevelDto, { ...BASE, active: false }))).toEqual(['active']);
        expect(Object.keys(await errorsOf(CreateServiceLevelDto, { ...BASE, id: 9 }))).toEqual(['id']);
    });
});

// ── edición ────────────────────────────────────────────────────────────────────
describe('UpdateServiceLevelDto', () => {
    it('un PUT vacío es válido (todo es opcional)', async () => {
        expect(await errorsOf(UpdateServiceLevelDto, {})).toEqual({});
    });

    it('acepta cada campo con un valor válido', async () => {
        for (const patch of [{ name: 'Nuevo' }, { description: 'otra' }, { targetTimeMin: 15 }, { priorityLevel: 3 }, { active: false }, { active: true }]) {
            expect(await errorsOf(UpdateServiceLevelDto, patch), JSON.stringify(patch)).toEqual({});
        }
    });

    for (const [label, value, constraint] of BAD_TARGET_TIME) {
        it(`rechaza targetTimeMin = ${label}`, async () => {
            const errors = await errorsOf(UpdateServiceLevelDto, { targetTimeMin: value });
            expect(errors.targetTimeMin).toContain(constraint);
        });
    }

    it('acepta los tiempos válidos, incluido el mínimo', async () => {
        for (const [, value] of GOOD_TARGET_TIME) {
            expect(await errorsOf(UpdateServiceLevelDto, { targetTimeMin: value })).toEqual({});
        }
    });

    it('rechaza null en los campos obligatorios (la base los exige NOT NULL: sería un 500)', async () => {
        for (const field of ['name', 'targetTimeMin', 'priorityLevel', 'active']) {
            expect(Object.keys(await errorsOf(UpdateServiceLevelDto, { [field]: null })), field).toEqual([field]);
        }
    });

    it('description = null es válido: la columna es nullable y así se borra; también el texto vacío', async () => {
        expect(await errorsOf(UpdateServiceLevelDto, { description: null })).toEqual({});
        expect(await errorsOf(UpdateServiceLevelDto, { description: '' })).toEqual({});
    });

    it('active debe ser un booleano de verdad (no "false" ni 0)', async () => {
        for (const value of ['false', 'true', 0, 1]) {
            expect(Object.keys(await errorsOf(UpdateServiceLevelDto, { active: value })), String(value)).toEqual(['active']);
        }
    });

    it('valida prioridad, nombre y descripción como en el alta', async () => {
        expect((await errorsOf(UpdateServiceLevelDto, { priorityLevel: 0 })).priorityLevel).toBeDefined();
        expect((await errorsOf(UpdateServiceLevelDto, { priorityLevel: 32768 })).priorityLevel).toBeDefined();
        expect((await errorsOf(UpdateServiceLevelDto, { name: '   ' })).name).toContain('isNotEmpty');
        expect((await errorsOf(UpdateServiceLevelDto, { name: 'N'.repeat(51) })).name).toContain('maxLength');
        expect((await errorsOf(UpdateServiceLevelDto, { description: 'D'.repeat(256) })).description).toContain('maxLength');
        expect(plainToInstance(UpdateServiceLevelDto, { name: '  X  ' }).name).toBe('X');
    });
});

// ── parámetros del listado ─────────────────────────────────────────────────────
describe('FindAllServiceLevelsParamsDto', () => {
    const parse = (plain: object) => plainToInstance(FindAllServiceLevelsParamsDto, plain);

    it('sin parámetros: página 1, 10 por página, sin filtros', async () => {
        const dto = parse({});
        expect(await errorsOf(FindAllServiceLevelsParamsDto, {})).toEqual({});
        expect(dto).toMatchObject({ page: 1, limit: 10 });
        expect(dto.search).toBeUndefined();
        expect(dto.active).toBeUndefined();
    });

    it('convierte active desde el query string', () => {
        expect(parse({ active: 'true' }).active).toBe(true);
        expect(parse({ active: 'false' }).active).toBe(false);
    });

    it('un active que no es booleano se rechaza (transformToBoolean lanza un 400 al convertir)', () => {
        expect(() => parse({ active: 'maybe' })).toThrow();
        expect(() => parse({ active: '1' })).toThrow();
    });

    it('recorta search; acepta hasta 100 caracteres', async () => {
        expect(parse({ search: '  express  ' }).search).toBe('express');
        expect(await errorsOf(FindAllServiceLevelsParamsDto, { search: 'a'.repeat(100) })).toEqual({});
        expect(Object.keys(await errorsOf(FindAllServiceLevelsParamsDto, { search: 'a'.repeat(101) }))).toEqual(['search']);
    });

    it('limit máximo 100 y page/limit enteros positivos', async () => {
        expect(await errorsOf(FindAllServiceLevelsParamsDto, { limit: '100' })).toEqual({});
        for (const bad of [{ limit: '101' }, { limit: '0' }, { page: '0' }, { page: '1.5' }, { limit: 'abc' }]) {
            expect(Object.keys(await errorsOf(FindAllServiceLevelsParamsDto, bad)), JSON.stringify(bad)).toHaveLength(1);
        }
    });

    it('no acepta parámetros que no existen (por ejemplo sortBy: el orden es fijo, por prioridad)', async () => {
        expect(Object.keys(await errorsOf(FindAllServiceLevelsParamsDto, { sortBy: 'name' }))).toEqual(['sortBy']);
    });
});
