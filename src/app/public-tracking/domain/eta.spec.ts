import { describe, expect, it } from 'vitest';
import { buildEtaPath, minutesToWindowEnd, pathSeconds, secondsToMinutes } from './eta.js';

const driver = { lat: -17.78, lon: -63.18 };
const stopA = { lat: -17.79, lon: -63.19 };
const stopB = { lat: -17.8, lon: -63.2 };
const home = { lat: -17.81, lon: -63.21 };

describe('buildEtaPath', () => {
    it('goes from the driver straight to the customer when there is no stop before', () => {
        expect(buildEtaPath(driver, [], home)).toEqual([driver, home]);
    });

    it('passes through the previous stops in the order given, customer last', () => {
        expect(buildEtaPath(driver, [stopA, stopB], home)).toEqual([driver, stopA, stopB, home]);
    });

    it('skips a stop that has no coordinates instead of failing', () => {
        expect(buildEtaPath(driver, [stopA, null, stopB], home)).toEqual([driver, stopA, stopB, home]);
    });
});

describe('pathSeconds', () => {
    const matrix = [
        [0, 100, 999, 999],
        [100, 0, 200, 999],
        [999, 200, 0, 300],
        [999, 999, 300, 0],
    ];

    it('adds each leg to the next point and ignores every other pair of the matrix', () => {
        expect(pathSeconds(matrix, 4)).toBe(600);
        expect(pathSeconds(matrix, 2)).toBe(100);
    });

    it('is null when a leg has no route', () => {
        const broken = [[0, 100, 0], [100, 0, null], [0, 0, 0]];
        expect(pathSeconds(broken, 3)).toBeNull();
    });

    it('is null for a missing or invalid leg', () => {
        expect(pathSeconds([[0]], 2)).toBeNull();
        expect(pathSeconds([[0, Number.NaN], [0, 0]], 2)).toBeNull();
        expect(pathSeconds([[0, -5], [0, 0]], 2)).toBeNull();
    });
});

describe('secondsToMinutes', () => {
    it('rounds up', () => {
        expect(secondsToMinutes(0)).toBe(0);
        expect(secondsToMinutes(1)).toBe(1);
        expect(secondsToMinutes(60)).toBe(1);
        expect(secondsToMinutes(61)).toBe(2);
    });
});

describe('minutesToWindowEnd', () => {
    const now = new Date('2026-11-05T14:00:00Z');

    it('counts the minutes left until the slot ends, rounded up', () => {
        expect(minutesToWindowEnd(new Date('2026-11-05T15:30:00Z'), now)).toBe(90);
        expect(minutesToWindowEnd(new Date('2026-11-05T14:00:30Z'), now)).toBe(1);
    });

    it('is zero once the slot is over, never negative', () => {
        expect(minutesToWindowEnd(new Date('2026-11-05T13:00:00Z'), now)).toBe(0);
    });

    it('is null when the order has no slot', () => {
        expect(minutesToWindowEnd(null, now)).toBeNull();
    });
});
