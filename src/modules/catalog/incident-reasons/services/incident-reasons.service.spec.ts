// RF-A32 — IncidentReasonsService: filtros/orden del listado, código único y actualización parcial.
// Todo mockeado: sin DB ni red. (El comportamiento real contra Postgres —incl. la carrera de
// altas simultáneas— se cubre en test/incident-reasons.e2e-spec.ts.)
import { describe, expect, it, vi } from 'vitest';
import { QueryFailedError } from 'typeorm';
import { plainToInstance } from 'class-transformer';
import { IncidentReasonsService } from './incident-reasons.service.js';
import { IncidentReasonDto } from '../dto/incident-reason.dto.js';
import { FindAllIncidentReasonsParamsDto } from '../dto/find-all-incident-reasons-params.dto.js';
import { IncidentReasonNotFoundException, IncidentReasonCodeAlreadyExistsException } from '../exceptions/index.js';

const ROW = { id: 1, code: 'INC-CLI-AUS', name: 'Cliente ausente', requiresEvidence: true, active: true, createdAt: new Date('2026-01-01T00:00:00Z') };

function buildService() {
    const rawRepo = {
        existsBy:     vi.fn().mockResolvedValue(false),
        create:       vi.fn(() => ({})),
        save:         vi.fn(async (entity: any) => ({ id: 1, ...entity })),
        update:       vi.fn(),
        findOne:      vi.fn().mockResolvedValue(ROW),
        findAndCount: vi.fn().mockResolvedValue([[], 0]),
    };
    const service = new IncidentReasonsService(rawRepo as any);
    return { service, rawRepo };
}

const duplicateError = () => new QueryFailedError('INSERT ...', [], Object.assign(new Error('dup'), { code: '23505' }));
const otherDbError   = () => new QueryFailedError('INSERT ...', [], Object.assign(new Error('null'), { code: '23502' }));
const branches = (where: any) => (Array.isArray(where) ? where : [where]);
const op = (f: any) => ({ type: f.type, value: f.value });

// ── listado, orden y filtros ───────────────────────────────────────────────────
describe('IncidentReasonsService.findAll — orden y filtros', () => {
    const run = async (over: object = {}) => {
        const { service, rawRepo } = buildService();
        const result = await service.findAll(IncidentReasonDto, plainToInstance(FindAllIncidentReasonsParamsDto, over));
        return { options: rawRepo.findAndCount.mock.calls[0][0], result };
    };

    it('ordena por nombre por defecto, desempatando por id', async () => {
        const { options } = await run();
        expect(options.order).toEqual({ name: 'ASC', id: 'ASC' });
    });

    it('sortBy/sortOrder cambian el campo y la dirección, siempre con id ASC al final', async () => {
        expect((await run({ sortBy: 'code' })).options.order).toEqual({ code: 'ASC', id: 'ASC' });
        expect((await run({ sortBy: 'createdAt', sortOrder: 'desc' })).options.order).toEqual({ createdAt: 'DESC', id: 'ASC' });
    });

    it('sin filtros, el where es {}', async () => {
        expect((await run()).options.where).toEqual({});
    });

    it('active/requiresEvidence filtran; "" (vacío, convertido a null por el DTO) no filtra', async () => {
        expect((await run({ active: 'true' })).options.where).toEqual({ active: true });
        expect((await run({ requiresEvidence: 'false' })).options.where).toEqual({ requiresEvidence: false });
        expect((await run({ active: '' })).options.where).toEqual({});
        expect((await run({ active: '', requiresEvidence: 'true' })).options.where).toEqual({ requiresEvidence: true });
    });

    it('search busca en nombre o código (2 ramas del OR) con ILIKE contiene, sin distinguir mayúsculas', async () => {
        const list = branches((await run({ search: 'aus' })).options.where);
        expect(list).toHaveLength(2);
        expect(op(list[0].name)).toEqual({ type: 'ilike', value: '%aus%' });
        expect(op(list[1].code)).toEqual({ type: 'ilike', value: '%aus%' });
    });

    it('search escapa los comodines: "50%" se busca literalmente', async () => {
        const list = branches((await run({ search: '50%' })).options.where);
        expect(op(list[0].name).value).toBe('%50\\%%');
    });

    it('un search vacío o de solo espacios se ignora', async () => {
        expect((await run({ search: '' })).options.where).toEqual({});
        expect((await run({ search: '   ' })).options.where).toEqual({});
    });

    it('search + active/requiresEvidence: cada rama del OR conserva ambos filtros (no se los salta)', async () => {
        const list = branches((await run({ search: 'x', active: 'false', requiresEvidence: 'true' })).options.where);
        for (const branch of list) expect(branch).toMatchObject({ active: false, requiresEvidence: true });
    });

    it('pagination: skip/take y meta', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.findAndCount.mockResolvedValue([[ROW], 1]);

        const result = await service.findAll(IncidentReasonDto, plainToInstance(FindAllIncidentReasonsParamsDto, { page: '2', limit: '5' }));

        expect(rawRepo.findAndCount.mock.calls[0][0]).toMatchObject({ skip: 5, take: 5 });
        expect(result.meta).toEqual({ page: 2, limit: 5, total: 1, pages: 1 });
    });
});

// ── alta ──────────────────────────────────────────────────────────────────────
describe('IncidentReasonsService.create', () => {
    it('crea siempre activo, con manager cuando se pasa uno', async () => {
        const { service, rawRepo } = buildService();
        const managerRepo = { existsBy: vi.fn().mockResolvedValue(false), create: vi.fn(() => ({})), save: vi.fn(async (e: any) => ({ id: 9, ...e })), findOne: vi.fn().mockResolvedValue(ROW) };
        const manager = { getRepository: vi.fn(() => managerRepo) };

        await service.create(IncidentReasonDto, { code: 'X', name: 'X', requiresEvidence: true }, { manager } as any);

        expect(managerRepo.save).toHaveBeenCalledWith(expect.objectContaining({ active: true, code: 'X', requiresEvidence: true }));
        expect(rawRepo.save).not.toHaveBeenCalled();
    });

    it('código repetido (chequeo previo) → 409, sin llegar a guardar', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.existsBy.mockResolvedValue(true);

        await expect(service.create(IncidentReasonDto, { code: 'INC-CLI-AUS', name: 'x', requiresEvidence: false }))
            .rejects.toThrow(IncidentReasonCodeAlreadyExistsException);
        expect(rawRepo.save).not.toHaveBeenCalled();
    });

    it('código repetido (carrera — el índice único de la base) → el mismo 409, no un 500', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.save.mockRejectedValue(duplicateError());

        await expect(service.create(IncidentReasonDto, { code: 'X', name: 'x', requiresEvidence: false }))
            .rejects.toThrow(IncidentReasonCodeAlreadyExistsException);
    });

    it('otro error de la base se propaga tal cual (no se lo mapea a 409)', async () => {
        const { service, rawRepo } = buildService();
        const failure = otherDbError();
        rawRepo.save.mockRejectedValue(failure);

        await expect(service.create(IncidentReasonDto, { code: 'X', name: 'x', requiresEvidence: false })).rejects.toBe(failure);
    });
});

// ── edición ───────────────────────────────────────────────────────────────────
describe('IncidentReasonsService.update', () => {
    it('solo cambia los campos enviados', async () => {
        const { service, rawRepo } = buildService();

        await service.update(IncidentReasonDto, 1, { requiresEvidence: false });

        expect(rawRepo.update).toHaveBeenCalledWith(1, { requiresEvidence: false });
    });

    it('un PUT vacío no escribe nada', async () => {
        const { service, rawRepo } = buildService();

        await service.update(IncidentReasonDto, 1, {});

        expect(rawRepo.update).not.toHaveBeenCalled();
    });

    it('cambiar el código a uno ya usado por OTRO motivo → 409; al mismo código propio no se rechequea', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.existsBy.mockResolvedValue(true);

        await expect(service.update(IncidentReasonDto, 1, { code: 'OTHER' })).rejects.toThrow(IncidentReasonCodeAlreadyExistsException);

        rawRepo.existsBy.mockClear();
        await service.update(IncidentReasonDto, 1, { code: ROW.code });
        expect(rawRepo.existsBy).not.toHaveBeenCalled();
    });

    it('desactivar (RF-A32, Escenario 2) es una actualización normal — no borra ni toca otra cosa', async () => {
        const { service, rawRepo } = buildService();

        await service.update(IncidentReasonDto, 1, { active: false });

        expect(rawRepo.update).toHaveBeenCalledWith(1, { active: false });
    });

    it('motivo inexistente → 404, sin intentar escribir', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.findOne.mockResolvedValue(null);

        await expect(service.update(IncidentReasonDto, 999, { active: false })).rejects.toThrow(IncidentReasonNotFoundException);
        expect(rawRepo.update).not.toHaveBeenCalled();
    });

    it('el índice único (carrera al renombrar) también da 409 en vez de 500', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.update.mockRejectedValue(duplicateError());

        await expect(service.update(IncidentReasonDto, 1, { code: 'RACY' })).rejects.toThrow(IncidentReasonCodeAlreadyExistsException);
    });
});

// ── lectura ───────────────────────────────────────────────────────────────────
describe('IncidentReasonsService.findOneById', () => {
    it('throwException:false devuelve null en vez de lanzar', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.findOne.mockResolvedValue(null);

        expect(await service.findOneById(IncidentReasonDto, 1, { throwException: false })).toBeNull();
    });
});
