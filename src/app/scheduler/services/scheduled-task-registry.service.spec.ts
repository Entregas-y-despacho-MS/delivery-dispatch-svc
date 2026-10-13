import { describe, expect, it, vi } from 'vitest';
import { ScheduledTaskAlreadyRegisteredException } from '../exceptions/index.js';
import type { ScheduledTask } from '../ports/scheduled-task.js';
import { ScheduledTaskRegistry } from './scheduled-task-registry.service.js';

const task = (name: string): ScheduledTask => ({
    name,
    schedule: { kind: 'every-minutes', minutes: 15 },
    run: vi.fn(),
});

describe('ScheduledTaskRegistry', () => {
    it('registers tasks and finds them by name', () => {
        const registry = new ScheduledTaskRegistry();
        const generation = task('plan-generation');
        const cutoff = task('route-cutoff');

        registry.register(generation);
        registry.register(cutoff);

        expect(registry.get('plan-generation')).toBe(generation);
        expect(registry.list()).toEqual([generation, cutoff]);
    });

    it('returns undefined for a task that nobody registered', () => {
        expect(new ScheduledTaskRegistry().get('plan-generation')).toBeUndefined();
    });

    it('refuses two tasks with the same name', () => {
        const registry = new ScheduledTaskRegistry();
        registry.register(task('plan-generation'));

        expect(() => registry.register(task('plan-generation'))).toThrow(ScheduledTaskAlreadyRegisteredException);
    });
});
