import { describe, expect, it, vi } from 'vitest';
import { InboundMessagesService } from './inbound-messages.service.js';

const MESSAGE_ID = '0192f1e2-7c3a-7b41-9a1e-5d2f0c8e4a10';

describe('InboundMessagesService', () => {
    const build = (queryResult: unknown[] = []) => {
        const rawRepo = { existsBy: vi.fn() };
        const dataSource = { query: vi.fn().mockResolvedValue(queryResult) };
        return { rawRepo, dataSource, service: new InboundMessagesService(rawRepo as never, dataSource as never) };
    };

    it('wasProcessed asks the table for a processed receipt', async () => {
        const { service, rawRepo } = build();
        rawRepo.existsBy.mockResolvedValue(true);

        await expect(service.wasProcessed(MESSAGE_ID)).resolves.toBe(true);
        expect(rawRepo.existsBy).toHaveBeenCalledWith({ messageId: MESSAGE_ID, status: 'processed' });
    });

    it('records a processed message without an error detail', async () => {
        const { service, dataSource } = build([{ message_id: MESSAGE_ID }]);

        const stored = await service.record({
            messageId: MESSAGE_ID,
            status: 'processed',
            type: 'inventory.shipment.ready',
            source: 'inventory',
            errorDetail: 'ignored',
        });

        expect(stored).toBe(true);
        const [sql, params] = dataSource.query.mock.calls[0];
        expect(sql).toContain('ON CONFLICT (message_id) DO UPDATE');
        expect(params).toEqual([MESSAGE_ID, 'processed', 'inventory.shipment.ready', 'inventory', null]);
    });

    it('records a rejected message with its error detail', async () => {
        const { service, dataSource } = build([{ message_id: MESSAGE_ID }]);

        await service.record({
            messageId: MESSAGE_ID,
            status: 'rejected',
            type: 'inventory.shipment.ready',
            source: 'inventory',
            errorDetail: '[{"message":"x"}]',
        });

        expect(dataSource.query.mock.calls[0][1][4]).toBe('[{"message":"x"}]');
    });

    it('returns false when the message id was already stored', async () => {
        const { service } = build([]);

        await expect(
            service.record({ messageId: MESSAGE_ID, status: 'processed', type: 't', source: 's' }),
        ).resolves.toBe(false);
    });

    it('cuts type and source to the column length', async () => {
        const { service, dataSource } = build([{ message_id: MESSAGE_ID }]);

        await service.record({
            messageId: MESSAGE_ID,
            status: 'processed',
            type: 't'.repeat(150),
            source: 's'.repeat(150),
        });

        const params = dataSource.query.mock.calls[0][1];
        expect(params[2]).toHaveLength(100);
        expect(params[3]).toHaveLength(100);
    });
});
