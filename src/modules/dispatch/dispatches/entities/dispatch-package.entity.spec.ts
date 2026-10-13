import { describe, expect, it } from 'vitest';
import { getMetadataArgsStorage } from 'typeorm';
import { Dispatch } from './dispatch.entity.js';
import { DispatchPackage } from './dispatch-package.entity.js';

describe('Dispatch and DispatchPackage metadata', () => {
    it('loads their circular relation without evaluating Dispatch before initialization', () => {
        const relation = getMetadataArgsStorage().relations.find((entry) =>
            entry.target === DispatchPackage && entry.propertyName === 'dispatch');

        expect(relation).toBeDefined();
        expect(relation?.type).toBeInstanceOf(Function);
        expect(relation?.type).not.toBe(DispatchPackage);
        expect(Dispatch).toBeInstanceOf(Function);
    });
});
