// Regresión: PUT con null en una columna NOT NULL debe ser 400, no un 500 de la base.
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateDeliveryZoneDto } from './update-delivery-zone.dto.js';

const OPTIONS = { whitelist: true, forbidNonWhitelisted: true };
const errorsOf = async (plain: object) =>
    (await validate(plainToInstance(UpdateDeliveryZoneDto, plain), OPTIONS)).map((e) => e.property);

describe('UpdateDeliveryZoneDto', () => {
    it('un PUT vacío es válido (todo es opcional)', async () => {
        expect(await errorsOf({})).toEqual([]);
    });

    it('acepta cada campo con un valor válido', async () => {
        expect(await errorsOf({ code: 'ZON-SUR' })).toEqual([]);
        expect(await errorsOf({ name: 'Zona Sur' })).toEqual([]);
        expect(await errorsOf({ estimatedTimeMin: 45 })).toEqual([]);
    });

    for (const field of ['code', 'name', 'estimatedTimeMin']) {
        it(`rechaza ${field} = null (la columna es NOT NULL)`, async () => {
            expect(await errorsOf({ [field]: null })).toEqual([field]);
        });
    }

    it('sigue rechazando tiempo estimado ≤ 0 o no entero (RF-A29, Escenario 3)', async () => {
        for (const value of [0, -5, 1.5, '30']) {
            expect(await errorsOf({ estimatedTimeMin: value }), String(value)).toEqual(['estimatedTimeMin']);
        }
    });

    it('sigue rechazando textos demasiado largos', async () => {
        expect(await errorsOf({ code: 'C'.repeat(21) })).toEqual(['code']);
        expect(await errorsOf({ name: 'N'.repeat(101) })).toEqual(['name']);
    });
});
