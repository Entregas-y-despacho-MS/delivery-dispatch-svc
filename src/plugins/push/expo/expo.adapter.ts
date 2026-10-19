import { Injectable, Logger } from '@nestjs/common';
import { Expo, type ExpoPushMessage, type ExpoPushTicket } from 'expo-server-sdk';
import {
    PushPort,
    type PushMessage,
    type PushReceiptOutcome,
    type PushReceiptReference,
    type PushSendOutcome,
} from '../push.port.js';

export const EXPO_CLIENT = Symbol('EXPO_CLIENT');

@Injectable()
export class ExpoPushAdapter extends PushPort {
    private readonly logger = new Logger(ExpoPushAdapter.name);

    constructor(private readonly client: Expo) {
        super();
    }

    async send(messages: PushMessage[]): Promise<PushSendOutcome[]> {
        const outcomes: PushSendOutcome[] = [];
        const valid: PushMessage[] = [];

        for (const message of messages) {
            if (!Expo.isExpoPushToken(message.to)) {
                outcomes.push({ token: message.to, status: 'permanent-error', error: 'Invalid Expo push token format.' });
            } else {
                valid.push(message);
            }
        }

        const sdkMessages = valid.map((message) => this.toSdkMessage(message));
        let offset = 0;
        for (const chunk of this.client.chunkPushNotifications(sdkMessages)) {
            const chunkMessages = valid.slice(offset, offset + chunk.length);
            offset += chunk.length;
            try {
                const tickets = await this.client.sendPushNotificationsAsync(chunk);
                chunkMessages.forEach((message, index) => outcomes.push(this.fromTicket(message.to, tickets[index])));
            } catch (error) {
                const retryable = isTransientProviderError(error);
                const detail = errorMessage(error);
                this.logger.warn(`Expo push request failed (${retryable ? 'temporary' : 'permanent'}): ${detail}`);
                chunkMessages.forEach(({ to }) => outcomes.push({
                    token: to,
                    status: retryable ? 'retryable-error' : 'permanent-error',
                    error: detail,
                }));
            }
        }
        return outcomes;
    }

    async getReceipts(references: PushReceiptReference[]): Promise<PushReceiptOutcome[]> {
        const outcomes: PushReceiptOutcome[] = [];
        const refsById = new Map(references.map((reference) => [reference.receiptId, reference]));
        const chunks = this.client.chunkPushNotificationReceiptIds(references.map(({ receiptId }) => receiptId));

        for (const chunk of chunks) {
            const receipts = await this.client.getPushNotificationReceiptsAsync(chunk);
            for (const [receiptId, receipt] of Object.entries(receipts)) {
                const reference = refsById.get(receiptId);
                if (!reference) continue;
                if (receipt.status === 'ok') {
                    outcomes.push({ ...reference, status: 'ok' });
                } else if (receipt.details?.error === 'DeviceNotRegistered') {
                    outcomes.push({ ...reference, status: 'invalid-token', error: receipt.details.error });
                } else {
                    outcomes.push({ ...reference, status: 'permanent-error', error: receipt.details?.error ?? receipt.message });
                }
            }
        }

        // Expo omits a receipt that is not ready yet; the processor keeps those references pending.
        return outcomes;
    }

    private toSdkMessage(message: PushMessage): ExpoPushMessage {
        return {
            to: message.to,
            title: message.title,
            body: message.body,
            data: message.data,
            sound: 'default',
            priority: message.data?.priority === 'urgent' ? 'high' : 'default',
        };
    }

    private fromTicket(token: string, ticket: ExpoPushTicket | undefined): PushSendOutcome {
        if (!ticket) return { token, status: 'retryable-error', error: 'Expo returned no ticket for the notification.' };
        if (ticket.status === 'ok') return { token, status: 'accepted', receiptId: ticket.id };

        const providerError = ticket.details?.error;
        if (providerError === 'DeviceNotRegistered') return { token, status: 'invalid-token', error: providerError };
        if (providerError === 'MessageRateExceeded' || providerError === 'ProviderError' || providerError === 'ExpoError') {
            return { token, status: 'retryable-error', error: providerError };
        }
        return { token, status: 'permanent-error', error: providerError ?? ticket.message };
    }
}

function isTransientProviderError(error: unknown): boolean {
    const value = error as { statusCode?: number; code?: string; cause?: { code?: string }; errors?: { code?: string }[] };
    // expo-server-sdk already retries HTTP 429 twice with exponential backoff (three requests total).
    if (value.statusCode === 429 || value.code === 'TOO_MANY_REQUESTS' || value.errors?.some(({ code }) => code === 'TOO_MANY_REQUESTS')) return false;
    if (value.statusCode !== undefined && value.statusCode >= 500) return true;
    return ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'ECONNABORTED']
        .includes(value.code ?? value.cause?.code ?? '');
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'object' && error !== null && 'message' in error) return String(error.message);
    return String(error);
}
