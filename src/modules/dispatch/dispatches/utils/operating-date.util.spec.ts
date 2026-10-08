// ST-28.4 — "hoy" del repartidor es el día calendario de Bolivia, no el del servidor (que corre en UTC).
import { describe, expect, it } from 'vitest';
import { OPERATING_TIME_ZONE, todayInOperatingTimeZone } from './operating-date.util.js';

describe('todayInOperatingTimeZone', () => {
    it('la zona horaria de operación es America/La_Paz', () => {
        expect(OPERATING_TIME_ZONE).toBe('America/La_Paz');
    });

    it('a las 20:00 en La Paz (00:00 UTC del día siguiente) sigue siendo el día local', () => {
        expect(todayInOperatingTimeZone(new Date('2026-10-15T00:00:00Z'))).toBe('2026-10-14');
    });

    it('a las 03:59 UTC todavía es el día anterior en La Paz, y a las 04:00 UTC ya empezó el nuevo', () => {
        expect(todayInOperatingTimeZone(new Date('2026-10-14T03:59:00Z'))).toBe('2026-10-13');
        expect(todayInOperatingTimeZone(new Date('2026-10-14T04:00:00Z'))).toBe('2026-10-14');
    });

    it('devuelve el formato YYYY-MM-DD con ceros a la izquierda', () => {
        expect(todayInOperatingTimeZone(new Date('2026-01-05T12:00:00Z'))).toBe('2026-01-05');
    });
});
