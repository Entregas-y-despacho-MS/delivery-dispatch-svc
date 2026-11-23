import { describe, expect, it } from 'vitest';
import { EXCLUSION_CODE_PATTERN } from '../../../../app/planning-snapshots/domain/cutoff-exclusion.js';
import { COTEJO_FAILED_EXCLUSION_CODE, buildManifestStops, type ManifestSourceStop } from './manifest-stops.js';

it('uses an exclusion code the database accepts', () => {
    expect(COTEJO_FAILED_EXCLUSION_CODE).toMatch(EXCLUSION_CODE_PATTERN);
});

const stop = (dispatchId: number, sequenceOrder: number | null, dispatchTypeId = 1): ManifestSourceStop => ({ dispatchId, dispatchTypeId, sequenceOrder });

describe('buildManifestStops', () => {
    it('plans every stop of a confirmed manifest, in visiting order', () => {
        const rows = buildManifestStops('confirmed', [stop(30, 3), stop(10, 1), stop(20, 2)], []);
        expect(rows.map((row) => [row.dispatchId, row.stopState, row.exclusionCode])).toEqual([
            [10, 'planned', null],
            [20, 'planned', null],
            [30, 'planned', null],
        ]);
    });

    it('splits a started manifest into the stops that leave and the ones held back with their code', () => {
        const rows = buildManifestStops('started', [stop(10, 1), stop(20, 2), stop(30, 3)], [20]);
        expect(rows.map((row) => [row.dispatchId, row.stopState, row.exclusionCode])).toEqual([
            [10, 'departing', null],
            [20, 'excluded', COTEJO_FAILED_EXCLUSION_CODE],
            [30, 'departing', null],
        ]);
    });

    it('treats a revised manifest like a started one', () => {
        const rows = buildManifestStops('revised', [stop(10, 1), stop(20, 2)], [10]);
        expect(rows.map((row) => row.stopState)).toEqual(['excluded', 'departing']);
    });

    it('keeps the type of the dispatch, which separates deliveries from pickups', () => {
        const rows = buildManifestStops('started', [stop(10, 1, 1), stop(20, 2, 3)], []);
        expect(rows.map((row) => row.dispatchTypeId)).toEqual([1, 3]);
    });

    it('puts a stop without sequence last and breaks ties by dispatch', () => {
        const rows = buildManifestStops('started', [stop(5, null), stop(9, 1), stop(4, null)], []);
        expect(rows.map((row) => row.dispatchId)).toEqual([9, 4, 5]);
        expect(rows[1].sequenceOrder).toBeNull();
    });

    it('makes an empty route an empty manifest', () => {
        expect(buildManifestStops('revised', [], [])).toEqual([]);
    });

    it('refuses exclusions in a confirmed manifest', () => {
        expect(() => buildManifestStops('confirmed', [stop(10, 1)], [10])).toThrow('no excluded stops');
    });

    it('refuses to exclude a dispatch that is not a stop of the route', () => {
        expect(() => buildManifestStops('started', [stop(10, 1)], [99])).toThrow('Dispatches 99');
    });

    it('does not change its input', () => {
        const source = [stop(2, 2), stop(1, 1)];
        const copy = source.map((item) => ({ ...item }));
        buildManifestStops('started', source, [2]);
        expect(source).toEqual(copy);
    });
});
