import { Injectable, Logger } from '@nestjs/common';
import { PushTokensService } from '../../modules/auth/push-tokens/services/push-tokens.service.js';
import type { RouteAssignedEvent } from '../../modules/dispatch/route-batches/events/route-assigned.event.js';
import type { RouteVehicleChangedEvent } from '../../modules/dispatch/route-batches/events/route-vehicle-changed.event.js';
import { PushPort, type PushMessage, type PushReceiptReference } from '../../plugins/push/push.port.js';
import { sendWithPushRetry } from '../../plugins/push/push-retry.js';
import { PushReceiptMonitor } from './push-receipt-monitor.js';

@Injectable()
export class RoutePushNotificationService {
    private readonly logger = new Logger(RoutePushNotificationService.name);

    constructor(
        private readonly pushTokens: PushTokensService,
        private readonly provider: PushPort,
        private readonly receipts: PushReceiptMonitor,
    ) {}

    /** Sends one route notification to every active device using the immutable approval event snapshot. */
    async notify(event: RouteAssignedEvent): Promise<void> {
        try {
            if (event.dispatchIds.length === 0) return;
            const tokens = await this.pushTokens.findActiveByUserId(event.driverId);
            if (tokens.length === 0) return;

            const priority = event.dispatches.some(({ priority: value }) => value === 'urgent') ? 'urgent' : 'normal';
            const count = event.dispatchIds.length;
            const message: Omit<PushMessage, 'to'> = {
                title: 'Nueva ruta asignada',
                body: `Tienes ${count} ${count === 1 ? 'pedido' : 'pedidos'} asignado${count === 1 ? '' : 's'} en ${event.zoneName}.`,
                data: {
                    dispatchId: event.dispatchIds[0],
                    zoneName: event.zoneName,
                    priority,
                    routeId: event.routeId,
                },
            };
            const messages = tokens.map(({ token }) => ({ ...message, to: token }));
            const outcomes = await sendWithPushRetry(this.provider, messages);
            const receipts: PushReceiptReference[] = [];

            for (const outcome of outcomes) {
                if (outcome.status === 'accepted' && outcome.receiptId) {
                    receipts.push({ token: outcome.token, receiptId: outcome.receiptId });
                } else if (outcome.status === 'invalid-token') {
                    await this.revokeInvalidToken(outcome.token);
                } else if (outcome.status === 'permanent-error' || outcome.status === 'retryable-error') {
                    this.logger.warn(`Push notification was not delivered (${outcome.status}): ${outcome.error}`);
                }
            }

            this.receipts.add(receipts);
        } catch (error) {
            // EventEmitter listeners run after the route transaction commits; provider failures never undo assignment.
            this.logger.error(`Route push notification failed: ${errorMessage(error)}`);
        }
    }

    /** Informs the already assigned driver that a confirmed route's vehicle changed. */
    async notifyVehicleChanged(event: RouteVehicleChangedEvent): Promise<void> {
        try {
            if (event.driverId === null) return;
            const tokens = await this.pushTokens.findActiveByUserId(event.driverId);
            if (tokens.length === 0) return;

            const message: Omit<PushMessage, 'to'> = {
                title: 'Vehículo de ruta actualizado',
                body: event.acceptanceRevoked
                    ? `El lote #${event.routeId} ahora usa ${event.vehiclePlate}. Revísalo y vuelve a aceptarlo antes de iniciar.`
                    : `El lote #${event.routeId} ahora usa ${event.vehiclePlate}.`,
                data: {
                    routeId: event.routeId,
                    vehicleId: event.vehicleId,
                    vehiclePlate: event.vehiclePlate,
                    version: event.version,
                    acceptanceRevoked: event.acceptanceRevoked,
                },
            };
            const messages = tokens.map(({ token }) => ({ ...message, to: token }));
            const outcomes = await sendWithPushRetry(this.provider, messages);
            const receipts: PushReceiptReference[] = [];

            for (const outcome of outcomes) {
                if (outcome.status === 'accepted' && outcome.receiptId) {
                    receipts.push({ token: outcome.token, receiptId: outcome.receiptId });
                } else if (outcome.status === 'invalid-token') {
                    await this.revokeInvalidToken(outcome.token);
                } else if (outcome.status === 'permanent-error' || outcome.status === 'retryable-error') {
                    this.logger.warn(`Vehicle change push notification was not delivered (${outcome.status}): ${outcome.error}`);
                }
            }

            this.receipts.add(receipts);
        } catch (error) {
            // This listener runs after commit: provider failures never undo a vehicle replacement.
            this.logger.error(`Vehicle change push notification failed: ${errorMessage(error)}`);
        }
    }

    private async revokeInvalidToken(token: string): Promise<void> {
        try {
            await this.pushTokens.revokeByToken(token);
            this.logger.log('Revoked a push token rejected by the provider.');
        } catch (error) {
            this.logger.error(`Could not revoke a rejected push token: ${errorMessage(error)}`);
        }
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
