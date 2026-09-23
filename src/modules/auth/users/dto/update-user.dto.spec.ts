// Regresión: PUT con null en una columna NOT NULL debe ser 400, no un 500 (o un TypeError en el
// servicio, como pasaba con password). email es la excepción: la columna es nullable.
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateUserDto } from './update-user.dto.js';

const OPTIONS = { whitelist: true, forbidNonWhitelisted: true };
const errorsOf = async (plain: object) =>
    (await validate(plainToInstance(UpdateUserDto, plain), OPTIONS)).map((e) => e.property);

describe('UpdateUserDto', () => {
    it('un PUT vacío es válido (todo es opcional)', async () => {
        expect(await errorsOf({})).toEqual([]);
    });

    it('acepta cada campo con un valor válido', async () => {
        expect(await errorsOf({ fullName: 'Ana Torrez' })).toEqual([]);
        expect(await errorsOf({ username: 'atorrez' })).toEqual([]);
        expect(await errorsOf({ email: 'ana@x.com' })).toEqual([]);
        expect(await errorsOf({ password: 'NewPassw0rd!' })).toEqual([]);
        expect(await errorsOf({ roleId: 2 })).toEqual([]);
        expect(await errorsOf({ active: false })).toEqual([]);
    });

    for (const field of ['fullName', 'username', 'password', 'roleId', 'active']) {
        it(`rechaza ${field} = null (la columna es NOT NULL)`, async () => {
            expect(await errorsOf({ [field]: null })).toEqual([field]);
        });
    }

    it('email = null sigue permitido: la columna es nullable y así se borra el email', async () => {
        expect(await errorsOf({ email: null })).toEqual([]);
    });

    it('sigue rechazando valores inválidos', async () => {
        expect(await errorsOf({ email: 'no-es-un-email' })).toEqual(['email']);
        expect(await errorsOf({ password: 'corta' })).toEqual(['password']);
        expect(await errorsOf({ roleId: 0 })).toEqual(['roleId']);
        expect(await errorsOf({ active: 'si' })).toEqual(['active']);
    });
});
