// RF-A33 — RescheduleReasonsService: filtros/orden del listado, unicidad de código/nombre y
// actualización parcial. Todo mockeado: sin DB ni red. (El comportamiento real contra Postgres
// —incl. la carrera de altas simultáneas— se cubre en test/reschedule-reasons.e2e-spec.ts.)
import { describe, expect, it, vi } from 'vitest';
import { QueryFailedError } from 'typeorm';
import { plainToInstance } from 'class-transformer';
import { RescheduleReasonsService } from './reschedule-reasons.service.js';
import { RescheduleReasonDto } from '../dto/reschedule-reason.dto.js';
import { FindAllRescheduleReasonsParamsDto } from '../dto/find-all-reschedule-reasons-params.dto.js';
import { RescheduleReasonNotFoundException, RescheduleReasonCodeAlreadyExistsException } from '../exceptions/index.js';
import { RescheduleReasonCategoryEnum } from '../../../../shared/enums/index.js';

const ROW = { id: 1, code: 'RES-CLI-EXP', name: 'Solicitud expresa del cliente', description: null, category: 'client', active: true, createdAt: new Date('2026-01-01T00:00:00Z') };

function buildService() {
    const rawRepo = {
        existsBy:     vi.fn().mockResolvedValue(false),
        create:       vi.fn(() => ({})),
        save:         vi.fn(async (entity: any) => ({ id: 1, ...entity })),
        update:       vi.fn(),
        findOne:      vi.fn().mockResolvedValue(ROW),
        findAndCount: vi.fn().mockResolvedValue([[], 0]),
    };
    const service = new RescheduleReasonsService(rawRepo as any);
    return { service, rawRepo };
}

const duplicateError = () => new QueryFailedError('INSERT ...', [], Object.assign(new Error('dup'), { code: '23505' }));
const otherDbError   = () => new QueryFailedError('INSERT ...', [], Object.assign(new Error('null'), { code: '23502' }));
const branches = (where: any) => (Array.isArray(where) ? where : [where]);
const op = (f: any) => ({ type: f.type, value: f.value });
const validCreate = (over: object = {}) => ({ code: 'RES-X', name: 'X', category: RescheduleReasonCategoryEnum.CLIENT, ...over });

// ── listado, orden y filtros ───────────────────────────────────────────────────
describe('RescheduleReasonsService.findAll — orden y filtros', () => {
    const run = async (over: object = {}) => {
        const { service, rawRepo } = buildService();
        const result = await service.findAll(RescheduleReasonDto, plainToInstance(FindAllRescheduleReasonsParamsDto, over));
        return { options: rawRepo.findAndCount.mock.calls[0][0], result };
    };

    it('ordena por nombre por defecto, desempatando por id', async () => {
        expect((await run()).options.order).toEqual({ name: 'ASC', id: 'ASC' });
    });

    it('sortBy/sortOrder cambian el campo y la dirección, siempre con id ASC al final', async () => {
        expect((await run({ sortBy: 'code' })).options.order).toEqual({ code: 'ASC', id: 'ASC' });
        expect((await run({ sortBy: 'category' })).options.order).toEqual({ category: 'ASC', id: 'ASC' });
        expect((await run({ sortBy: 'createdAt', sortOrder: 'desc' })).options.order).toEqual({ createdAt: 'DESC', id: 'ASC' });
    });

    it('sin filtros, el where es {}', async () => {
        expect((await run()).options.where).toEqual({});
    });

    it('category y active filtran; un active vacío (convertido a null por el DTO) no filtra', async () => {
        expect((await run({ category: 'client' })).options.where).toEqual({ category: 'client' });
        expect((await run({ active: 'true' })).options.where).toEqual({ active: true });
        expect((await run({ active: '' })).options.where).toEqual({});
        expect((await run({ active: '', category: 'operations' })).options.where).toEqual({ category: 'operations' });
    });

    it('search busca en código, nombre o descripción (3 ramas del OR) con ILIKE contiene, sin distinguir mayúsculas', async () => {
        const list = branches((await run({ search: 'client' })).options.where);
        expect(list).toHaveLength(3);
        expect(op(list[0].code)).toEqual({ type: 'ilike', value: '%client%' });
        expect(op(list[1].name)).toEqual({ type: 'ilike', value: '%client%' });
        expect(op(list[2].description)).toEqual({ type: 'ilike', value: '%client%' });
    });

    it('search escapa los comodines: "50%" se busca literalmente', async () => {
        expect(op(branches((await run({ search: '50%' })).options.where)[0].code).value).toBe('%50\\%%');
    });

    it('un search vacío o de solo espacios se ignora', async () => {
        expect((await run({ search: '' })).options.where).toEqual({});
        expect((await run({ search: '   ' })).options.where).toEqual({});
    });

    it('search + category + active: cada rama del OR conserva ambos filtros', async () => {
        const list = branches((await run({ search: 'x', active: 'false', category: 'force_majeure' })).options.where);
        for (const branch of list) expect(branch).toMatchObject({ active: false, category: 'force_majeure' });
    });

    it('pagination: skip/take y meta', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.findAndCount.mockResolvedValue([[ROW], 1]);

        const result = await service.findAll(RescheduleReasonDto, plainToInstance(FindAllRescheduleReasonsParamsDto, { page: '2', limit: '5' }));

        expect(rawRepo.findAndCount.mock.calls[0][0]).toMatchObject({ skip: 5, take: 5 });
        expect(result.meta).toEqual({ page: 2, limit: 5, total: 1, pages: 1 });
    });
});

// ── alta ──────────────────────────────────────────────────────────────────────
describe('RescheduleReasonsService.create', () => {
    it('crea siempre activo, con manager cuando se pasa uno', async () => {
        const { service, rawRepo } = buildService();
        const managerRepo = { existsBy: vi.fn().mockResolvedValue(false), create: vi.fn(() => ({})), save: vi.fn(async (e: any) => ({ id: 9, ...e })), findOne: vi.fn().mockResolvedValue(ROW) };
        const manager = { getRepository: vi.fn(() => managerRepo) };

        await service.create(RescheduleReasonDto, validCreate({ category: RescheduleReasonCategoryEnum.OPERATIONS }), { manager } as any);

        expect(managerRepo.save).toHaveBeenCalledWith(expect.objectContaining({ active: true, code: 'RES-X', name: 'X', category: RescheduleReasonCategoryEnum.OPERATIONS }));
        expect(rawRepo.save).not.toHaveBeenCalled();
    });

    it('description opcional: omitida o vacía queda null', async () => {
        const { service, rawRepo } = buildService();

        await service.create(RescheduleReasonDto, validCreate());
        expect(rawRepo.save).toHaveBeenCalledWith(expect.objectContaining({ description: null }));

        await service.create(RescheduleReasonDto, validCreate({ code: 'RES-Y', name: 'Y', description: '' }));
        expect(rawRepo.save).toHaveBeenLastCalledWith(expect.objectContaining({ description: null }));
    });

    it('nombre repetido (chequeo previo) → 409, sin llegar a guardar', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.existsBy.mockImplementation(async ({ name }: any) => name === ROW.name);

        await expect(service.create(RescheduleReasonDto, validCreate({ code: 'RES-NEW', name: ROW.name })))
            .rejects.toThrow(RescheduleReasonCodeAlreadyExistsException);
        expect(rawRepo.save).not.toHaveBeenCalled();
    });

    it('código repetido (chequeo previo) → 409, sin llegar a guardar ni a chequear el nombre', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.existsBy.mockResolvedValue(true); // el primer existsBy (code) ya da true

        await expect(service.create(RescheduleReasonDto, validCreate({ code: ROW.code })))
            .rejects.toThrow(RescheduleReasonCodeAlreadyExistsException);
        expect(rawRepo.existsBy).toHaveBeenCalledTimes(1); // no llegó a chequear name
        expect(rawRepo.save).not.toHaveBeenCalled();
    });

    it('nombre o código repetido (carrera — el índice único de la base) → el mismo 409, no un 500', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.save.mockRejectedValue(duplicateError());

        await expect(service.create(RescheduleReasonDto, validCreate()))
            .rejects.toThrow(RescheduleReasonCodeAlreadyExistsException);
    });

    it('otro error de la base se propaga tal cual (no se lo mapea a 409)', async () => {
        const { service, rawRepo } = buildService();
        const failure = otherDbError();
        rawRepo.save.mockRejectedValue(failure);

        await expect(service.create(RescheduleReasonDto, validCreate())).rejects.toBe(failure);
    });
});

// ── edición ───────────────────────────────────────────────────────────────────
describe('RescheduleReasonsService.update', () => {
    it('solo cambia los campos enviados', async () => {
        const { service, rawRepo } = buildService();

        await service.update(RescheduleReasonDto, 1, { category: RescheduleReasonCategoryEnum.OPERATIONS });

        expect(rawRepo.update).toHaveBeenCalledWith(1, { category: RescheduleReasonCategoryEnum.OPERATIONS });
    });

    it('un PUT vacío no escribe nada', async () => {
        const { service, rawRepo } = buildService();

        await service.update(RescheduleReasonDto, 1, {});

        expect(rawRepo.update).not.toHaveBeenCalled();
    });

    it('la descripción se puede borrar con null o texto vacío', async () => {
        const { service, rawRepo } = buildService();

        await service.update(RescheduleReasonDto, 1, { description: null });
        expect(rawRepo.update).toHaveBeenLastCalledWith(1, { description: null });

        await service.update(RescheduleReasonDto, 1, { description: '' });
        expect(rawRepo.update).toHaveBeenLastCalledWith(1, { description: null });
    });

    it('cambiar el nombre a uno ya usado por OTRO motivo → 409; al mismo nombre propio no se rechequea', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.existsBy.mockResolvedValue(true);

        await expect(service.update(RescheduleReasonDto, 1, { name: 'Otro' })).rejects.toThrow(RescheduleReasonCodeAlreadyExistsException);

        rawRepo.existsBy.mockClear();
        await service.update(RescheduleReasonDto, 1, { name: ROW.name });
        expect(rawRepo.existsBy).not.toHaveBeenCalled();
    });

    it('cambiar el código a uno ya usado por OTRO motivo → 409; al mismo código propio no se rechequea', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.existsBy.mockResolvedValue(true);

        await expect(service.update(RescheduleReasonDto, 1, { code: 'RES-OTRO' })).rejects.toThrow(RescheduleReasonCodeAlreadyExistsException);

        rawRepo.existsBy.mockClear();
        await service.update(RescheduleReasonDto, 1, { code: ROW.code });
        expect(rawRepo.existsBy).not.toHaveBeenCalled();
    });

    it('desactivar (no hay borrado en este catálogo) es una actualización normal', async () => {
        const { service, rawRepo } = buildService();

        await service.update(RescheduleReasonDto, 1, { active: false });

        expect(rawRepo.update).toHaveBeenCalledWith(1, { active: false });
    });

    it('motivo inexistente → 404, sin intentar escribir', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.findOne.mockResolvedValue(null);

        await expect(service.update(RescheduleReasonDto, 999, { active: false })).rejects.toThrow(RescheduleReasonNotFoundException);
        expect(rawRepo.update).not.toHaveBeenCalled();
    });

    it('el índice único (carrera al renombrar) también da 409 en vez de 500', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.update.mockRejectedValue(duplicateError());

        await expect(service.update(RescheduleReasonDto, 1, { name: 'Racy' })).rejects.toThrow(RescheduleReasonCodeAlreadyExistsException);
    });
});

// ── lectura ───────────────────────────────────────────────────────────────────
describe('RescheduleReasonsService.findOneById', () => {
    it('throwException:false devuelve null en vez de lanzar', async () => {
        const { service, rawRepo } = buildService();
        rawRepo.findOne.mockResolvedValue(null);

        expect(await service.findOneById(RescheduleReasonDto, 1, { throwException: false })).toBeNull();
    });
});
