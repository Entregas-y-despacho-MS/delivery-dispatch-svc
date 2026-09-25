// RF-A28, Escenario 3 — el estado que muestra el listado se calcula, no se guarda.
import { describe, expect, it } from 'vitest';
import { computeUserStatus } from './user-status.util.js';
import { UserStatusEnum } from '../../../../shared/enums/index.js';

const NOW = new Date('2026-09-24T12:00:00.000Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

describe('computeUserStatus', () => {
    it('activo y sin bloqueo → active', () => {
        expect(computeUserStatus(true, null, NOW)).toBe(UserStatusEnum.ACTIVE);
        expect(computeUserStatus(true, undefined, NOW)).toBe(UserStatusEnum.ACTIVE);
    });

    it('activo con bloqueo vigente (locked_until en el futuro) → locked', () => {
        expect(computeUserStatus(true, minutes(15), NOW)).toBe(UserStatusEnum.LOCKED);
        expect(computeUserStatus(true, minutes(0.01), NOW)).toBe(UserStatusEnum.LOCKED);
    });

    it('un bloqueo ya vencido deja de contar → active', () => {
        expect(computeUserStatus(true, minutes(-1), NOW)).toBe(UserStatusEnum.ACTIVE);
    });

    it('locked_until justo ahora ya no está bloqueado (el bloqueo es "hasta" ese instante)', () => {
        expect(computeUserStatus(true, new Date(NOW), NOW)).toBe(UserStatusEnum.ACTIVE);
    });

    it('desactivado → inactive, con o sin bloqueo (inactive gana)', () => {
        expect(computeUserStatus(false, null, NOW)).toBe(UserStatusEnum.INACTIVE);
        expect(computeUserStatus(false, minutes(15), NOW)).toBe(UserStatusEnum.INACTIVE);
        expect(computeUserStatus(false, minutes(-15), NOW)).toBe(UserStatusEnum.INACTIVE);
    });

    it('sin "now" explícito usa la hora actual', () => {
        expect(computeUserStatus(true, new Date(Date.now() + 60_000))).toBe(UserStatusEnum.LOCKED);
        expect(computeUserStatus(true, new Date(Date.now() - 60_000))).toBe(UserStatusEnum.ACTIVE);
    });
});
