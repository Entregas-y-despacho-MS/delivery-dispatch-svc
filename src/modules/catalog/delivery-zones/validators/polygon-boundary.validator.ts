import {
    ValidationArguments,
    ValidatorConstraint,
    ValidatorConstraintInterface,
} from 'class-validator';

export type PolygonCoordinate = [longitude: number, latitude: number];
export type PolygonBoundary = PolygonCoordinate[];

@ValidatorConstraint({ name: 'isPolygonBoundary', async: false })
export class IsPolygonBoundaryConstraint implements ValidatorConstraintInterface {
    validate(value: unknown): boolean {
        // null is a supported value on update to remove the zone's coverage.
        if (value === undefined || value === null) return true;
        if (!Array.isArray(value) || value.length < 3) return false;

        const coordinates: PolygonCoordinate[] = [];
        for (const point of value) {
            if (
                !Array.isArray(point) || point.length !== 2 ||
                typeof point[0] !== 'number' || !Number.isFinite(point[0]) ||
                typeof point[1] !== 'number' || !Number.isFinite(point[1]) ||
                point[0] < -180 || point[0] > 180 || point[1] < -90 || point[1] > 90
            ) return false;
            coordinates.push([point[0], point[1]]);
        }

        // A GeoJSON-style closed ring is accepted; PostgreSQL closes polygons implicitly.
        if (coordinates.length > 3 && sameCoordinate(coordinates[0], coordinates.at(-1)!)) {
            coordinates.pop();
        }

        const distinct = new Set(coordinates.map(([longitude, latitude]) => `${longitude},${latitude}`));
        if (distinct.size < 3) return false;

        // Reject collinear/zero-area rings before they reach PostgreSQL.
        let twiceArea = 0;
        for (let index = 0; index < coordinates.length; index++) {
            const [longitude, latitude] = coordinates[index];
            const [nextLongitude, nextLatitude] = coordinates[(index + 1) % coordinates.length];
            twiceArea += longitude * nextLatitude - nextLongitude * latitude;
        }
        return Math.abs(twiceArea) > Number.EPSILON;
    }

    defaultMessage(args: ValidationArguments): string {
        return `${args.property} must contain at least three distinct, non-collinear [longitude, latitude] points within valid geographic ranges.`;
    }
}

function sameCoordinate(left: PolygonCoordinate, right: PolygonCoordinate): boolean {
    return left[0] === right[0] && left[1] === right[1];
}

/** Converts PostgreSQL's native polygon representation to/from the public coordinate-pair contract. */
export const polygonBoundaryTransformer = {
    to(value: PolygonBoundary | null | undefined): string | null | undefined {
        if (value === undefined || value === null) return value;
        return `(${value.map(([longitude, latitude]) => `(${longitude},${latitude})`).join(',')})`;
    },
    from(value: string | null | undefined): PolygonBoundary | null {
        if (value === null || value === undefined) return null;
        const matches = [...value.matchAll(/\(\s*(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*,\s*(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*\)/gi)];
        if (matches.length < 3) throw new Error('Unexpected PostgreSQL polygon representation.');
        return matches.map(([, longitude, latitude]) => [Number(longitude), Number(latitude)] as PolygonCoordinate);
    },
};
