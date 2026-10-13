import { DataSource } from 'typeorm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { MessageEnvelope } from '../../../../plugins/messaging/envelope/message-envelope.js';
import { generateMessageId } from '../../../../plugins/messaging/envelope/uuid-v7.js';
import { InboundMessageTransactionService } from './inbound-message-transaction.service.js';

/** Run only against a disposable PostgreSQL database with the delivery-dispatch-db schema. */
describe.skipIf(!process.env.TEST_DB_PORT)('InboundMessageTransaction against PostgreSQL', () => {
    let dataSource: DataSource;
    let service: InboundMessageTransactionService;
    const created: string[] = [];
    const action = 'codex_st724_transaction_test';

    function envelope(): MessageEnvelope {
        const messageId = generateMessageId();
        created.push(messageId);
        return {
            messageId, type: 'inventory.shipment.ready', source: 'inventory', schemaVersion: 1,
            occurredAt: new Date().toISOString(), data: { salesOrderId: 'SO-ST724-TEST' },
        };
    }

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'postgres',
            host: process.env.TEST_DB_HOST ?? 'localhost',
            port: Number(process.env.TEST_DB_PORT),
            username: process.env.TEST_DB_USER,
            password: process.env.TEST_DB_PASSWORD,
            database: process.env.TEST_DB_NAME,
        });
        await dataSource.initialize();
        service = new InboundMessageTransactionService(dataSource);
    });

    afterEach(async () => {
        await dataSource.query('DELETE FROM audit_logs WHERE action = $1', [action]);
        await dataSource.query('DELETE FROM inbound_messages WHERE message_id = ANY($1::uuid[])', [created]);
        created.length = 0;
    });

    afterAll(async () => { await dataSource?.destroy(); });

    it('commits business data and receipt together, then skips a duplicate', async () => {
        const message = envelope();
        const handle = async ({ manager }: { manager?: { query: (sql: string, params: unknown[]) => Promise<unknown> } }) => {
            await manager!.query('INSERT INTO audit_logs (user_id, action, detail) VALUES (NULL, $1, $2)', [action, message.messageId]);
        };

        expect(await service.process(message, 'SO-ST724-TEST', handle)).toBe('receipt-committed');
        expect(await service.process(message, 'SO-ST724-TEST', handle)).toBe('duplicate');
        const receipts = await dataSource.query('SELECT status FROM inbound_messages WHERE message_id = $1', [message.messageId]);
        const business = await dataSource.query('SELECT 1 FROM audit_logs WHERE action = $1 AND detail = $2', [action, message.messageId]);
        expect(receipts).toEqual([{ status: 'processed' }]);
        expect(business).toHaveLength(1);
    });

    it('rolls back business data and receipt when the handler fails', async () => {
        const message = envelope();
        await expect(service.process(message, 'SO-ST724-TEST', async ({ manager }) => {
            await manager!.query('INSERT INTO audit_logs (user_id, action, detail) VALUES (NULL, $1, $2)', [action, message.messageId]);
            throw new Error('generator failed');
        })).rejects.toThrow('generator failed');

        expect(await dataSource.query('SELECT 1 FROM inbound_messages WHERE message_id = $1', [message.messageId])).toHaveLength(0);
        expect(await dataSource.query('SELECT 1 FROM audit_logs WHERE action = $1 AND detail = $2', [action, message.messageId])).toHaveLength(0);
    });

    it('serializes two different messages for the same sales order', async () => {
        const first = envelope();
        const second = envelope();
        let active = 0;
        let maximum = 0;
        const handle = async () => {
            active += 1;
            maximum = Math.max(maximum, active);
            await new Promise((resolve) => setTimeout(resolve, 20));
            active -= 1;
        };

        expect(await Promise.all([
            service.process(first, 'SO-ST724-TEST', handle),
            service.process(second, 'SO-ST724-TEST', handle),
        ])).toEqual(['receipt-committed', 'receipt-committed']);
        expect(maximum).toBe(1);
    });
});
