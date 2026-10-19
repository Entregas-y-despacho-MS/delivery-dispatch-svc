import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PushTokensService } from '../../modules/auth/push-tokens/services/push-tokens.service.js';
import { PushPort, type PushReceiptReference } from '../../plugins/push/push.port.js';

const RECEIPT_CHECK_DELAY_MS = 15 * 60 * 1000;
const RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1000;

interface PendingReceipt extends PushReceiptReference {
    createdAt: number;
    nextCheckAt: number;
}

/** Tracks Expo ticket receipts in-process and revokes tokens reported as unregistered. */
@Injectable()
export class PushReceiptMonitor {
    private readonly logger = new Logger(PushReceiptMonitor.name);
    private readonly pending = new Map<string, PendingReceipt>();
    private polling = false;

    constructor(
        private readonly provider: PushPort,
        private readonly pushTokens: PushTokensService,
    ) {}

    add(receipts: PushReceiptReference[], now: Date = new Date()): void {
        const timestamp = now.getTime();
        for (const receipt of receipts) {
            this.pending.set(receipt.receiptId, {
                ...receipt,
                createdAt: timestamp,
                nextCheckAt: timestamp + RECEIPT_CHECK_DELAY_MS,
            });
        }
    }

    @Cron(CronExpression.EVERY_15_MINUTES)
    async poll(now: Date = new Date()): Promise<void> {
        if (this.polling) return;
        const timestamp = now.getTime();
        const due = [...this.pending.values()].filter(({ nextCheckAt }) => nextCheckAt <= timestamp);
        if (due.length === 0) return;

        this.polling = true;
        try {
            const outcomes = await this.provider.getReceipts(due);
            const resolved = new Set<string>();
            for (const outcome of outcomes) {
                const receipt = this.pending.get(outcome.receiptId);
                if (!receipt) continue;
                if (outcome.status === 'invalid-token') {
                    await this.pushTokens.revokeByToken(outcome.token);
                    this.logger.log('Revoked a push token rejected by its delivery receipt.');
                }
                resolved.add(outcome.receiptId);
                this.pending.delete(outcome.receiptId);
            }

            for (const receipt of due) {
                if (resolved.has(receipt.receiptId)) continue;
                if (timestamp - receipt.createdAt >= RECEIPT_RETENTION_MS) {
                    this.pending.delete(receipt.receiptId);
                    this.logger.warn('Discarded an Expo receipt that remained unavailable for 24 hours.');
                } else {
                    this.pending.set(receipt.receiptId, { ...receipt, nextCheckAt: timestamp + RECEIPT_CHECK_DELAY_MS });
                }
            }
        } catch (error) {
            this.logger.warn(`Push receipt polling failed: ${errorMessage(error)}`);
            for (const receipt of due) {
                if (timestamp - receipt.createdAt >= RECEIPT_RETENTION_MS) this.pending.delete(receipt.receiptId);
                else this.pending.set(receipt.receiptId, { ...receipt, nextCheckAt: timestamp + RECEIPT_CHECK_DELAY_MS });
            }
        } finally {
            this.polling = false;
        }
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
