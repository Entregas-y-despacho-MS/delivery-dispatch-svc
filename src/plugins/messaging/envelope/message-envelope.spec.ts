import { describe, expect, it } from 'vitest';
import { buildEnvelope } from './message-envelope.js';
import { generateMessageId } from './uuid-v7.js';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('generateMessageId', () => {
    it('returns a UUID v7', () => {
        expect(generateMessageId()).toMatch(UUID_V7);
    });

    it('returns time-ordered ids', async () => {
        const first = generateMessageId();
        await new Promise((done) => setTimeout(done, 2));
        const second = generateMessageId();

        expect(second > first).toBe(true);
    });
});

describe('buildEnvelope', () => {
    it('fills messageId, schemaVersion and occurredAt', () => {
        const at = new Date('2026-10-07T14:03:00.000Z');
        const envelope = buildEnvelope({
            type: 'dispatch.sync.requested',
            source: 'dispatch',
            data: { salesOrderId: 'SO-1' },
            occurredAt: at,
        });

        expect(envelope.messageId).toMatch(UUID_V7);
        expect(envelope.schemaVersion).toBe(1);
        expect(envelope.occurredAt).toBe('2026-10-07T14:03:00.000Z');
        expect(envelope.data).toEqual({ salesOrderId: 'SO-1' });
    });

    it('keeps an explicit messageId and schemaVersion', () => {
        const envelope = buildEnvelope({
            type: 'dispatch.sync.requested',
            source: 'dispatch',
            data: {},
            messageId: '0192f1e2-7c3a-7b41-9a1e-5d2f0c8e4a10',
            schemaVersion: 2,
        });

        expect(envelope.messageId).toBe('0192f1e2-7c3a-7b41-9a1e-5d2f0c8e4a10');
        expect(envelope.schemaVersion).toBe(2);
    });
});
