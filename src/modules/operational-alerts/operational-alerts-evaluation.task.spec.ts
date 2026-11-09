import { describe, expect, it, vi } from 'vitest';
import { OperationalAlertsEvaluationTask } from './operational-alerts-evaluation.task.js';
import { OPERATIONAL_ALERTS_EVALUATION_TASK } from '../../app/scheduler/scheduled-task-names.js';

function build() {
    const registry = { register: vi.fn() };
    const evaluation = { evaluateGpsStale: vi.fn(), evaluateDriverIncidents: vi.fn(), evaluateSlaBelowThreshold: vi.fn() };
    const task = new OperationalAlertsEvaluationTask(registry as never, evaluation as never);
    return { task, registry, evaluation };
}

describe('OperationalAlertsEvaluationTask', () => {
    it('registers itself every minute under its own name', () => {
        const { task, registry } = build();

        task.onModuleInit();

        expect(registry.register).toHaveBeenCalledWith(expect.objectContaining({
            name: OPERATIONAL_ALERTS_EVALUATION_TASK,
            schedule: { kind: 'every-minutes', minutes: 1 },
        }));
    });

    it('runs the three evaluations and reports all succeeded', async () => {
        const { task, registry, evaluation } = build();
        task.onModuleInit();
        const run = registry.register.mock.calls[0][0].run;

        const result = await run({ trigger: 'schedule', occurrence: null, startedAt: new Date() });

        expect(evaluation.evaluateGpsStale).toHaveBeenCalledOnce();
        expect(evaluation.evaluateDriverIncidents).toHaveBeenCalledOnce();
        expect(evaluation.evaluateSlaBelowThreshold).toHaveBeenCalledOnce();
        expect(result).toEqual({ gpsStale: true, driverIncidents: true, slaBelowThreshold: true });
    });

    it('one evaluation failing does not stop or fail the others', async () => {
        const { task, registry, evaluation } = build();
        evaluation.evaluateDriverIncidents.mockRejectedValue(new Error('boom'));
        task.onModuleInit();
        const run = registry.register.mock.calls[0][0].run;

        const result = await run({ trigger: 'schedule', occurrence: null, startedAt: new Date() });

        expect(evaluation.evaluateSlaBelowThreshold).toHaveBeenCalledOnce();
        expect(result).toEqual({ gpsStale: true, driverIncidents: false, slaBelowThreshold: true });
    });
});
