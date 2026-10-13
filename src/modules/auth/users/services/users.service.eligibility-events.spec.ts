// ST-50.4 — UsersService avisa (evento de dominio) cuando un usuario deja de ser elegible como revisor:
// desactivado, borrado o con otro rol. Todo mockeado: sin DB ni red.
import { describe, expect, it, vi } from 'vitest';
import { UsersService } from './users.service.js';
import { UserDto } from '../dto/user.dto.js';
import { USER_ELIGIBILITY_CHANGED_EVENT } from '../events/user-eligibility-changed.event.js';

function build(over: { active?: boolean; roleId?: number; emitThrows?: boolean } = {}) {
    const rawRepo = {
        findOne:    vi.fn().mockResolvedValue({ id: 5, username: 'ana', email: null, active: over.active ?? true, role: { id: over.roleId ?? 3 } }),
        update:     vi.fn().mockResolvedValue(undefined),
        softDelete: vi.fn().mockResolvedValue(undefined),
        delete:     vi.fn().mockResolvedValue(undefined),
    };
    const roleRepo = { existsBy: vi.fn().mockResolvedValue(true) };
    const events = { emit: vi.fn(() => { if (over.emitThrows) throw new Error('listener failed'); return true; }) };
    const service = new UsersService(rawRepo as any, { find: vi.fn() } as any, roleRepo as any, { getNumber: vi.fn() } as any, events as any);
    return { service, rawRepo, events };
}

describe('UsersService — evento user.eligibility_changed', () => {
    it('desactivar un usuario activo lo emite con el motivo deactivated', async () => {
        const { service, events } = build({ active: true });

        await service.update(UserDto, 5, { active: false } as any);

        expect(events.emit).toHaveBeenCalledWith(USER_ELIGIBILITY_CHANGED_EVENT, { userId: 5, reason: 'deactivated' });
    });

    it('editar sin desactivar, o desactivar a quien ya estaba inactivo, no lo emite', async () => {
        const a = build({ active: true });
        await a.service.update(UserDto, 5, { fullName: 'Ana B' } as any);
        expect(a.events.emit).not.toHaveBeenCalled();

        const b = build({ active: false });
        await b.service.update(UserDto, 5, { active: false } as any);
        expect(b.events.emit).not.toHaveBeenCalled();
    });

    it('cambiar de rol lo emite con el motivo role_changed; repetir el mismo rol no', async () => {
        const changed = build({ roleId: 3 });
        await changed.service.updateRole(UserDto, 5, 4);
        expect(changed.events.emit).toHaveBeenCalledWith(USER_ELIGIBILITY_CHANGED_EVENT, { userId: 5, reason: 'role_changed' });

        const same = build({ roleId: 3 });
        await same.service.updateRole(UserDto, 5, 3);
        expect(same.events.emit).not.toHaveBeenCalled();
    });

    it('borrar un usuario lo emite con el motivo deleted', async () => {
        const { service, events } = build();

        await service.remove(5);

        expect(events.emit).toHaveBeenCalledWith(USER_ELIGIBILITY_CHANGED_EVENT, { userId: 5, reason: 'deleted' });
    });

    it('un listener que falla no hace fallar la escritura', async () => {
        const { service, rawRepo } = build({ active: true, emitThrows: true });

        await expect(service.update(UserDto, 5, { active: false } as any)).resolves.toBeDefined();
        expect(rawRepo.update).toHaveBeenCalledWith(5, { active: false });
    });

    it('sin emisor (construcción con 4 argumentos) no falla', async () => {
        const rawRepo = { findOne: vi.fn().mockResolvedValue({ id: 5, username: 'a', email: null, active: true }), update: vi.fn() };
        const service = new UsersService(rawRepo as any, {} as any, {} as any, {} as any);

        await expect(service.update(UserDto, 5, { active: false } as any)).resolves.toBeDefined();
    });
});
