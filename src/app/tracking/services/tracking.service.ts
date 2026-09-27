import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DispatchesService } from '../../../modules/dispatch/dispatches/services/dispatches.service.js';
import { SocketService } from '../../../plugins/socket/socket.service.js';
import { SOCKET_CONNECTED_EVENT } from '../../../plugins/socket/events/socket-connected.event.js';
import type { SocketConnectedEvent } from '../../../plugins/socket/events/socket-connected.event.js';
import { RoleEnum } from '../../../shared/enums/index.js';
import { LocationPointDto } from '../dto/location-point.dto.js';
import { LocationReportOutcome, LocationReportResultDto, LocationsReportResultDto } from '../dto/location-report-result.dto.js';

// Everyone who watches the live dispatch board (RF-A06/A13) — auto-joined on connect, see
// handleSocketConnected() below. The plugin itself never sees this name or this role list.
export const DISPATCH_BOARD_ROOM = 'dispatch-board';
const DISPATCH_BOARD_ROLES: RoleEnum[] = [RoleEnum.ROOT, RoleEnum.ADMIN, RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR];

// A device clock is never exact, but a point from the future is not a real one — it would win the
// "newest wins" guardrail forever, blocking every real point that comes after it.
const MAX_FUTURE_MS = 2 * 60 * 1000;

// RF-U11 — ingesta de telemetría GPS del repartidor. Orquesta: valida pertenencia del despacho al
// repartidor, aplica los puntos en orden cronológico (así "el más nuevo gana" alcanza para quedarse
// solo con la última posición por despacho, sin un paso aparte de agrupar), y retransmite en vivo
// por socket. La escritura en sí (con su propio guardrail contra pisar algo más nuevo) vive en
// DispatchesService — acá no hay lógica de "cómo se guarda", solo "qué hacer con el resultado".
@Injectable()
export class TrackingService {
    constructor(
        private readonly dispatchesService: DispatchesService,
        private readonly socketService:     SocketService,
    ) {}

    /** Who gets to see the live map — the socket plugin has no idea this room or this rule exist. */
    @OnEvent(SOCKET_CONNECTED_EVENT)
    handleSocketConnected({ socketId, role }: SocketConnectedEvent): void {
        if (DISPATCH_BOARD_ROLES.includes(role)) {
            this.socketService.joinRoom(socketId, DISPATCH_BOARD_ROOM);
        }
    }

    /**
     * Applies every point oldest-first (by its own recordedAt, regardless of the order they were
     * sent in) — a batch synced after regaining signal is not necessarily in order, and applying
     * chronologically is what makes "only overwrite if newer" (DispatchesService.updateLocation)
     * naturally keep just the latest point per dispatch, without a separate group-by-dispatch step.
     */
    async reportLocations(points: LocationPointDto[], driverId: number): Promise<LocationsReportResultDto> {
        const results: LocationReportResultDto[] = Array.from({ length: points.length });
        const chronological = points
            .map((point, index) => ({ point, index }))
            .sort((a, b) => new Date(a.point.recordedAt).getTime() - new Date(b.point.recordedAt).getTime());

        for (const { point, index } of chronological) {
            results[index] = await this.processOne(point, driverId);
        }
        return { results };
    }

    private async processOne(point: LocationPointDto, driverId: number): Promise<LocationReportResultDto> {
        if (this.isImplausibleFuture(point.recordedAt)) {
            return { dispatchId: point.dispatchId, outcome: LocationReportOutcome.FAILED, error: 'recordedAt is too far in the future. Check the device clock.' };
        }

        // Unknown dispatch and someone else's dispatch answer the same: a driver cannot probe other routes.
        if (!(await this.dispatchesService.isAssignedToDriver(point.dispatchId, driverId))) {
            return { dispatchId: point.dispatchId, outcome: LocationReportOutcome.FAILED, error: 'Dispatch not found.' };
        }

        const applied = await this.dispatchesService.updateLocation(point.dispatchId, {
            latitude:   point.latitude,
            longitude:  point.longitude,
            recordedAt: new Date(point.recordedAt),
        });
        if (!applied) return { dispatchId: point.dispatchId, outcome: LocationReportOutcome.STALE };

        this.socketService.emitToRoom(DISPATCH_BOARD_ROOM, 'dispatch.location.updated', {
            dispatchId: point.dispatchId,
            latitude:   point.latitude,
            longitude:  point.longitude,
            recordedAt: point.recordedAt,
        });
        return { dispatchId: point.dispatchId, outcome: LocationReportOutcome.APPLIED };
    }

    private isImplausibleFuture(recordedAt: string): boolean {
        return new Date(recordedAt).getTime() > Date.now() + MAX_FUTURE_MS;
    }
}
