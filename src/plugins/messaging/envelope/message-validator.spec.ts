import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MessagingContractsNotFoundException } from '../exceptions/index.js';
import { MessageValidator } from './message-validator.js';

const CONTRACTS_DIR = resolve(process.cwd(), 'contracts/messages');
const example = (topic: string): Record<string, any> =>
    JSON.parse(readFileSync(resolve(CONTRACTS_DIR, 'examples', `${topic}.example.json`), 'utf8'));

describe('MessageValidator', () => {
    const validator = MessageValidator.fromDirectory(CONTRACTS_DIR);

    it('loads every topic of the contracts folder', () => {
        expect(validator.topics).toContain('inventory.shipment.ready');
        expect(validator.topics).toContain('dispatch.transfer.status_changed');
        expect(validator.topics).toHaveLength(17);
    });

    it.each(validator.topics)('accepts the example of %s', (topic) => {
        expect(validator.validate(topic, example(topic))).toEqual({ valid: true });
    });

    it('rejects a message with a missing required field and lists the errors', () => {
        const message = example('inventory.shipment.ready');
        delete message.data.warehouseId;
        delete message.data.packages;

        const result = validator.validate('inventory.shipment.ready', message);

        expect(result.valid).toBe(false);
        if (result.valid) return;
        expect(result.errors.length).toBeGreaterThanOrEqual(2);
        expect(result.errors.map((error) => error.keyword)).toContain('required');
        expect(result.errors.map((error) => error.message).join(' ')).toContain('warehouseId');
    });

    it('rejects a messageId that is not a UUID v7', () => {
        const message = example('inventory.shipment.ready');
        message.messageId = '0192f1e2-7c3a-4b41-9a1e-5d2f0c8e4a10';

        const result = validator.validate('inventory.shipment.ready', message);

        expect(result.valid).toBe(false);
        if (result.valid) return;
        expect(result.errors[0].path).toBe('/messageId');
    });

    it('rejects a message whose type does not match its topic', () => {
        const message = example('inventory.shipment.ready');
        message.type = 'inventory.shipment.updated';

        expect(validator.validate('inventory.shipment.ready', message).valid).toBe(false);
    });

    it('rejects a message that is not an object', () => {
        expect(validator.validate('inventory.shipment.ready', 'not json').valid).toBe(false);
        expect(validator.validate('inventory.shipment.ready', null).valid).toBe(false);
    });

    it('rejects an unknown topic', () => {
        const result = validator.validate('unknown.topic.name', example('inventory.shipment.ready'));

        expect(result).toEqual({
            valid: false,
            errors: [{ path: '', message: 'Unknown topic "unknown.topic.name".', keyword: 'unknownTopic' }],
        });
    });

    it('fails with a clear exception when the contracts folder does not exist', () => {
        expect(() => MessageValidator.fromDirectory(resolve(CONTRACTS_DIR, 'missing'))).toThrow(
            MessagingContractsNotFoundException,
        );
    });
});
