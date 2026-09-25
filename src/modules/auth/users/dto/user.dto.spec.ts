// RF-A28, Escenario 3 — UserDto trae el estado calculado y la fecha del último acceso.
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { UserDto } from './user.dto.js';
import { buildFindOptions } from '../../../../shared/orm/index.js';

const row = (over: object = {}) => ({
    id: 1, fullName: 'Ana Torrez', username: 'atorrez', email: 'ana@x.com', active: true,
    twoFactorEnabled: false, requiresPwdChange: false, lockedUntil: null, lastLoginAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'), role: { id: 3, name: 'coordinator', createdAt: new Date() },
    ...over,
});
const toDto = (r: object) => plainToInstance(UserDto, r, { excludeExtraneousValues: true });

describe('UserDto', () => {
    it('calcula status al mapear la fila (active / inactive / locked)', () => {
        expect(toDto(row()).status).toBe('active');
        expect(toDto(row({ active: false })).status).toBe('inactive');
        expect(toDto(row({ lockedUntil: new Date(Date.now() + 60_000) })).status).toBe('locked');
        expect(toDto(row({ lockedUntil: new Date(Date.now() - 60_000) })).status).toBe('active');
    });

    it('devuelve lastLoginAt y lockedUntil tal cual (null = nunca ingresó / sin bloqueo)', () => {
        const login = new Date('2026-09-24T14:03:00Z');
        expect(toDto(row()).lastLoginAt).toBeNull();
        expect(toDto(row({ lastLoginAt: login })).lastLoginAt).toEqual(login);
        expect(toDto(row()).lockedUntil).toBeNull();
    });

    it('status NO es una columna: no entra al SELECT, pero sus fuentes sí', () => {
        const { select } = buildFindOptions(UserDto);
        expect(select.status).toBeUndefined();
        expect(select).toMatchObject({ active: true, lockedUntil: true, lastLoginAt: true });
    });

    it('no filtra datos sensibles aunque la fila los traiga', () => {
        const dto = toDto(row({ passwordHash: 'x', refreshTokenHash: 'y', twoFactorSecret: 'z' }));
        expect(Object.keys(dto)).not.toEqual(expect.arrayContaining(['passwordHash', 'refreshTokenHash', 'twoFactorSecret']));
    });
});
