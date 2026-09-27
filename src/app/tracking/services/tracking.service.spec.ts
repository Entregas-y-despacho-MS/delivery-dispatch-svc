// RF-U11 — TrackingService: orden cronológico del lote, el resultado por punto, y quién se une a
// la sala 'dispatch-board'. Todo mockeado: sin DB ni socket real. (El guardrail de "no pisar algo
// más nuevo" en sí se prueba en dispatches.service.spec.ts — acá solo se confirma que se usa.)
import { describe, expect, it, vi } from 'vitest';
import { DISPATCH_BOARD_ROOM, TrackingService } from './tracking.service.js';
import { LocationReportOutcome } from '../dto/location-report-result.dto.js';
import { LocationPointDto } from '../dto/location-point.dto.js';

function buildService() {
    const dispatchesService = {
        isAssignedToDriver: vi.fn().mockResolvedValue(true),
        updateLocation:     vi.fn().mockResolvedValue(true),
    };
    const socketService = {
        joinRoom:    vi.fn(),
        emitToRoom:  vi.fn(),
    };
    const service = new TrackingService(dispatchesService as any, socketService as any);
    return { service, dispatchesService, socketService };
}

// Todas relativas a "ahora" — nunca una fecha fija, para no depender de qué día sea al correr los tests.
const NOW = Date.now();
const isoMinutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const point = (over: Partial<LocationPointDto> = {}): LocationPointDto => ({
    dispatchId: 42,
    latitude:   -17.783,
    longitude:  -63.182,
    recordedAt: isoMinutesAgo(5),
    ...over,
});

describe('TrackingService.reportLocations', () => {
    it('un punto válido: applied + se retransmite por socket a dispatch-board', async () => {
        const { service, socketService } = buildService();
        const p = point();

        const { results } = await service.reportLocations([p], 5);

        expect(results).toEqual([{ dispatchId: 42, outcome: LocationReportOutcome.APPLIED }]);
        expect(socketService.emitToRoom).toHaveBeenCalledWith(DISPATCH_BOARD_ROOM, 'dispatch.location.updated', {
            dispatchId: 42, latitude: -17.783, longitude: -63.182, recordedAt: p.recordedAt,
        });
    });

    it('despacho ajeno o inexistente (isAssignedToDriver false) → failed, sin llegar a escribir ni emitir', async () => {
        const { service, dispatchesService, socketService } = buildService();
        dispatchesService.isAssignedToDriver.mockResolvedValue(false);

        const { results } = await service.reportLocations([point()], 5);

        expect(results).toEqual([{ dispatchId: 42, outcome: LocationReportOutcome.FAILED, error: 'Dispatch not found.' }]);
        expect(dispatchesService.updateLocation).not.toHaveBeenCalled();
        expect(socketService.emitToRoom).not.toHaveBeenCalled();
    });

    it('recordedAt muy en el futuro → failed, sin llegar a validar pertenencia ni escribir', async () => {
        const { service, dispatchesService } = buildService();
        const farFuture = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1h

        const { results } = await service.reportLocations([point({ recordedAt: farFuture })], 5);

        expect(results[0]).toMatchObject({ outcome: LocationReportOutcome.FAILED });
        expect(results[0].error).toMatch(/future/i);
        expect(dispatchesService.isAssignedToDriver).not.toHaveBeenCalled();
    });

    it('guardrail rechaza el punto por viejo (updateLocation → false) → stale, no error, no emite', async () => {
        const { service, dispatchesService, socketService } = buildService();
        dispatchesService.updateLocation.mockResolvedValue(false);

        const { results } = await service.reportLocations([point()], 5);

        expect(results).toEqual([{ dispatchId: 42, outcome: LocationReportOutcome.STALE }]);
        expect(socketService.emitToRoom).not.toHaveBeenCalled();
    });

    it('un lote fuera de orden se aplica cronológicamente (el más viejo primero), no en el orden en que se envió', async () => {
        const { service, dispatchesService } = buildService();
        const older = point({ dispatchId: 1, recordedAt: isoMinutesAgo(10) });
        const newer = point({ dispatchId: 2, recordedAt: isoMinutesAgo(5) });

        // Se manda el más nuevo primero en el array — igual debe aplicarse después.
        await service.reportLocations([newer, older], 5);

        expect(dispatchesService.updateLocation.mock.calls[0][0]).toBe(1); // older, dispatchId 1, va primero
        expect(dispatchesService.updateLocation.mock.calls[1][0]).toBe(2); // newer, dispatchId 2, va después
    });

    it('los resultados se devuelven en el mismo orden en que se enviaron los puntos, no en el cronológico', async () => {
        const { service } = buildService();
        const older = point({ dispatchId: 1, recordedAt: isoMinutesAgo(10) });
        const newer = point({ dispatchId: 2, recordedAt: isoMinutesAgo(5) });

        const { results } = await service.reportLocations([newer, older], 5);

        expect(results.map((r) => r.dispatchId)).toEqual([2, 1]); // mismo orden que el array enviado
    });

    it('procesa varios puntos del lote, cada uno con su propio resultado', async () => {
        const { service, dispatchesService } = buildService();
        dispatchesService.isAssignedToDriver.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

        const { results } = await service.reportLocations([point({ dispatchId: 1 }), point({ dispatchId: 2 })], 5);

        expect(results).toHaveLength(2);
        expect(results.find((r) => r.dispatchId === 2)?.outcome).toBe(LocationReportOutcome.FAILED);
    });
});

describe('TrackingService.handleSocketConnected — quién ve el tablero en vivo', () => {
    it.each(['root', 'admin', 'coordinator', 'supervisor'])('%s se une a dispatch-board al conectarse', (role) => {
        const { service, socketService } = buildService();

        service.handleSocketConnected({ socketId: 'sock-1', userId: 1, role: role as any });

        expect(socketService.joinRoom).toHaveBeenCalledWith('sock-1', DISPATCH_BOARD_ROOM);
    });

    it('driver NO se une (no necesita ver el tablero: es quien reporta la posición, no quien la mira)', () => {
        const { service, socketService } = buildService();

        service.handleSocketConnected({ socketId: 'sock-1', userId: 1, role: 'driver' as any });

        expect(socketService.joinRoom).not.toHaveBeenCalled();
    });
});
