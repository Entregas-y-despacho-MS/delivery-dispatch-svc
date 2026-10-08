// ST-28.4 — validación del parámetro `date` de "Mi Jornada". Sin DB ni red: class-validator directo,
// con las mismas opciones del ValidationPipe global.
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { FindDriverAssignmentsParamsDto } from './find-driver-assignments-params.dto.js';

const OPTIONS = { whitelist: true, forbidNonWhitelisted: true };

async function errorProperties(plain: object): Promise<string[]> {
    return (await validate(plainToInstance(FindDriverAssignmentsParamsDto, plain), OPTIONS)).map((e) => e.property);
}

describe('FindDriverAssignmentsParamsDto', () => {
    it('sin fecha es válido (se usa hoy)', async () => {
        expect(await errorProperties({})).toEqual([]);
    });

    it('acepta una fecha YYYY-MM-DD', async () => {
        expect(await errorProperties({ date: '2026-10-14' })).toEqual([]);
    });

    it.each(['14-10-2026', '2026/10/14', '2026-13-01', '2026-02-30', 'hoy', '', '2026-10-14T10:00:00Z'])('rechaza %j', async (date) => {
        expect(await errorProperties({ date })).toEqual(['date']);
    });

    it('rechaza parámetros que no existen (el repartidor nunca se elige por parámetro)', async () => {
        expect(await errorProperties({ driverId: 5 })).toEqual(['driverId']);
    });
});
