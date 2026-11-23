import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { RoleEnum } from '../../../shared/enums/role.enum.js';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator.js';
import { PlanningPipelineController } from './planning-pipeline.controller.js';

describe('PlanningPipelineController', () => {
    it('passes the filters of the request to the service', async () => {
        const service = { getPipeline: vi.fn().mockResolvedValue({ data: [] }) };
        const params = { page: 1, limit: 10, date: '2026-11-23', stage: 'exception' } as never;
        const result = await new PlanningPipelineController(service as never).getPipeline(params);
        expect(service.getPipeline).toHaveBeenCalledWith(params);
        expect(result).toEqual({ data: [] });
    });

    it('is for the coordinator only (root passes every guard)', () => {
        const roles = Reflect.getMetadata(ROLES_KEY, PlanningPipelineController.prototype.getPipeline) as string[];
        expect(roles).toEqual([RoleEnum.COORDINATOR]);
    });
});
