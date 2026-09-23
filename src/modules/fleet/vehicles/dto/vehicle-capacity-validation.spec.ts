// ST-22.3 — validaciones de peso (kg) y volumen (m3) de los DTOs de vehículos (RF-A30, Escenario 3).
// Sin DB ni red: valida los DTOs directamente con class-validator. El comportamiento por HTTP
// (400, nada guardado) se cubre en test/vehicles.e2e-spec.ts.
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateVehicleDto } from './create-vehicle.dto.js';
import { UpdateVehicleDto } from './update-vehicle.dto.js';

const BASE = { type: 'camioneta', model: 'Toyota Hilux 2022', plate: '1234-ABC', capacityKg: 1200.5, capacityM3: 8.5 };
const FIELDS = ['capacityKg', 'capacityM3'] as const;

// Same options the global ValidationPipe uses in main.ts.
const OPTIONS = { whitelist: true, forbidNonWhitelisted: true };

async function errorsOf<T extends object>(cls: new () => T, plain: object): Promise<Record<string, string[]>> {
    const errors = await validate(plainToInstance(cls, plain), OPTIONS);
    return Object.fromEntries(errors.map((e) => [e.property, Object.keys(e.constraints ?? {})]));
}

const INVALID: [label: string, value: unknown, expectedConstraint: string][] = [
    ['cero',                          0,                'isPositive'],
    ['negativo',                      -1,               'isPositive'],
    ['negativo con decimales',        -0.01,            'isPositive'],
    ['más de 2 decimales',            10.123,           'isNumber'],
    ['3 decimales aunque sea chico',  0.001,            'isNumber'],
    ['justo sobre el máximo',         100000000,        'max'],
    ['muy por encima del máximo',     1e9,              'max'],
    ['string numérico',               '100',            'isNumber'],
    ['null',                          null,             'isNumber'],
    ['booleano',                      true,             'isNumber'],
    ['array',                         [],               'isNumber'],
    ['objeto',                        {},               'isNumber'],
    ['NaN',                           Number.NaN,       'isNumber'],
    ['Infinity',                      Infinity,         'isNumber'],
    ['-Infinity',                     -Infinity,        'isNumber'],
];

const VALID: [label: string, value: number][] = [
    ['el mínimo positivo (0.01)',     0.01],
    ['entero',                        1],
    ['con un decimal',                1200.5],
    ['con dos decimales',             1200.55],
    ['con cero decimal explícito',    10.1],
    ['el máximo de NUMERIC(10,2)',    99999999.99],
];

describe('CreateVehicleDto — capacidades (RF-A30, Escenario 3)', () => {
    it('un vehículo válido no tiene errores', async () => {
        expect(await errorsOf(CreateVehicleDto, BASE)).toEqual({});
    });

    for (const field of FIELDS) {
        describe(field, () => {
            for (const [label, value, constraint] of INVALID) {
                it(`rechaza ${label}`, async () => {
                    const errors = await errorsOf(CreateVehicleDto, { ...BASE, [field]: value });
                    expect(Object.keys(errors)).toEqual([field]); // solo ese campo falla, el otro sigue válido
                    expect(errors[field]).toContain(constraint);
                });
            }

            for (const [label, value] of VALID) {
                it(`acepta ${label}`, async () => {
                    expect(await errorsOf(CreateVehicleDto, { ...BASE, [field]: value })).toEqual({});
                });
            }

            it('es obligatorio (faltante)', async () => {
                const { [field]: _omitted, ...rest } = BASE;
                const errors = await errorsOf(CreateVehicleDto, rest);
                expect(Object.keys(errors)).toEqual([field]);
            });
        });
    }

    it('peso y volumen inválidos a la vez: se reportan los dos', async () => {
        const errors = await errorsOf(CreateVehicleDto, { ...BASE, capacityKg: 0, capacityM3: -5 });
        expect(Object.keys(errors).sort()).toEqual(['capacityKg', 'capacityM3']);
    });

    it('los mensajes de error nombran la unidad (kg / m3)', async () => {
        const errors = await validate(plainToInstance(CreateVehicleDto, { ...BASE, capacityKg: 0, capacityM3: 0 }), OPTIONS);
        const messages = errors.flatMap((e) => Object.values(e.constraints ?? {}));
        expect(messages).toContain('Capacity in kg must be greater than zero.');
        expect(messages).toContain('Capacity in m3 must be greater than zero.');
    });
});

describe('CreateVehicleDto — placa y campos de texto', () => {
    it('normaliza la placa: recorta espacios y pasa a mayúsculas', () => {
        const dto = plainToInstance(CreateVehicleDto, { ...BASE, plate: '  1234-abc  ' });
        expect(dto.plate).toBe('1234-ABC');
    });

    it('una placa solo de espacios queda vacía y se rechaza', async () => {
        const errors = await errorsOf(CreateVehicleDto, { ...BASE, plate: '    ' });
        expect(errors.plate).toContain('isNotEmpty');
    });

    it('rechaza texto vacío o demasiado largo', async () => {
        expect((await errorsOf(CreateVehicleDto, { ...BASE, type: '' })).type).toContain('isNotEmpty');
        expect((await errorsOf(CreateVehicleDto, { ...BASE, model: '' })).model).toContain('isNotEmpty');
        expect((await errorsOf(CreateVehicleDto, { ...BASE, plate: 'X'.repeat(16) })).plate).toContain('maxLength');
        expect((await errorsOf(CreateVehicleDto, { ...BASE, model: 'M'.repeat(101) })).model).toContain('maxLength');
        expect((await errorsOf(CreateVehicleDto, { ...BASE, type: 'T'.repeat(51) })).type).toContain('maxLength');
    });

    it('no acepta campos que no son del alta (estado, id)', async () => {
        expect(Object.keys(await errorsOf(CreateVehicleDto, { ...BASE, vehicleStatusId: 2 }))).toEqual(['vehicleStatusId']);
        expect(Object.keys(await errorsOf(CreateVehicleDto, { ...BASE, id: 99 }))).toEqual(['id']);
    });
});

describe('UpdateVehicleDto — capacidades (RF-A30, Escenario 3)', () => {
    it('un PUT vacío es válido (todo es opcional)', async () => {
        expect(await errorsOf(UpdateVehicleDto, {})).toEqual({});
    });

    for (const field of FIELDS) {
        describe(field, () => {
            for (const [label, value, constraint] of INVALID) {
                // null se cubre aparte abajo: no debe colarse como "campo omitido".
                if (value === null) continue;
                it(`rechaza ${label}`, async () => {
                    const errors = await errorsOf(UpdateVehicleDto, { [field]: value });
                    expect(errors[field]).toContain(constraint);
                });
            }

            for (const [label, value] of VALID) {
                it(`acepta ${label}`, async () => {
                    expect(await errorsOf(UpdateVehicleDto, { [field]: value })).toEqual({});
                });
            }

            it('rechaza null (borrar la capacidad no es una actualización válida)', async () => {
                const errors = await errorsOf(UpdateVehicleDto, { [field]: null });
                expect(Object.keys(errors)).toEqual([field]);
            });
        });
    }

    it('rechaza null en cualquier otro campo (la base los exige NOT NULL)', async () => {
        for (const field of ['type', 'model', 'plate', 'vehicleStatusId']) {
            const errors = await errorsOf(UpdateVehicleDto, { [field]: null });
            expect(Object.keys(errors), field).toEqual([field]);
        }
    });

    it('normaliza la placa igual que en el alta', () => {
        expect(plainToInstance(UpdateVehicleDto, { plate: ' abc-123 ' }).plate).toBe('ABC-123');
    });
});
