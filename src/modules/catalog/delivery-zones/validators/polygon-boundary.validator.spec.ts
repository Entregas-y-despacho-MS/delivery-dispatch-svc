import { describe, expect, it } from 'vitest';
import { IsPolygonBoundaryConstraint, polygonBoundaryTransformer } from './polygon-boundary.validator.js';

describe('IsPolygonBoundaryConstraint', () => {
    const validator = new IsPolygonBoundaryConstraint();

    it('acepta un polígono válido y anillo cerrado', () => {
        expect(validator.validate([[-68.15, -16.5], [-68.1, -16.5], [-68.1, -16.45], [-68.15, -16.5]])).toBe(true);
    });

    it('acepta null para mantener zonas sin cobertura o limpiar el polígono', () => {
        expect(validator.validate(null)).toBe(true);
    });

    it('rechaza menos de tres puntos distintos', () => {
        expect(validator.validate([[-68, -16], [-68, -16], [-68, -16]])).toBe(false);
    });

    it('rechaza coordenadas fuera de rango y geometría degenerada', () => {
        expect(validator.validate([[-181, -16], [-68, -16], [-67, -15]])).toBe(false);
        expect(validator.validate([[0, 0], [1, 1], [2, 2]])).toBe(false);
    });
});

describe('polygonBoundaryTransformer', () => {
    it('convierte pares de coordenadas al tipo polygon de PostgreSQL y de regreso', () => {
        const boundary: [number, number][] = [[-68.15, -16.5], [-68.1, -16.5], [-68.1, -16.45]];
        const postgresValue = polygonBoundaryTransformer.to(boundary);
        expect(postgresValue).toBe('((-68.15,-16.5),(-68.1,-16.5),(-68.1,-16.45))');
        expect(polygonBoundaryTransformer.from(postgresValue!)).toEqual(boundary);
    });

    it('conserva null al leer o escribir', () => {
        expect(polygonBoundaryTransformer.to(null)).toBeNull();
        expect(polygonBoundaryTransformer.from(null)).toBeNull();
    });
});
