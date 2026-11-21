import { describe, expect, it } from 'vitest';
import { deadLetteredMessageId, judgeAck, judgeStep, parseAck, type ObservedAck } from './complaint-acks.js';

/** Lectura de los acuses del reclamo de CRM que imprime `npm run simulate:crm` (ST-298.4). */
const envelope = (type: string, messageId: string, data: Record<string, unknown>): string =>
    JSON.stringify({ messageId, type, schemaVersion: 1, source: 'dispatch', occurredAt: '2026-11-21T12:00:00Z', data });

const received = (messageId = 'ack-1', correlation = 'msg-1'): ObservedAck => ({
    outcome: 'received',
    messageId,
    correlationMessageId: correlation,
});
const rejected = (code: string, extra: Partial<ObservedAck> = {}, messageId = 'ack-1'): ObservedAck => ({
    outcome: 'rejected',
    messageId,
    correlationMessageId: 'msg-1',
    rejectionCode: code,
    ...extra,
});

describe('parseAck', () => {
    it('lee un received con su correlación', () => {
        const ack = parseAck(
            envelope('dispatch.delivery_complaint.received', 'a1', {
                correlationMessageId: 'm1',
                crmCaseId: 'CASE-1',
                caseVersion: 2,
                dispatchId: 10,
                trackingCode: 'DSP-2026-00010',
            }),
        );
        expect(ack).toEqual({
            outcome: 'received',
            messageId: 'a1',
            correlationMessageId: 'm1',
            crmCaseId: 'CASE-1',
            caseVersion: 2,
        });
    });

    it('lee un rejected con código y campo', () => {
        const ack = parseAck(
            envelope('dispatch.delivery_complaint.rejected', 'a2', {
                correlationMessageId: 'm2',
                rejectionCode: 'schema_invalid',
                field: '/data/affectedItems',
            }),
        );
        expect(ack).toMatchObject({ outcome: 'rejected', rejectionCode: 'schema_invalid', field: '/data/affectedItems' });
    });

    it.each([
        ['no es JSON', 'esto no es json'],
        ['es otro tópico', envelope('dispatch.sync.requested', 'a3', { correlationMessageId: 'm3' })],
        ['no trae correlación', envelope('dispatch.delivery_complaint.received', 'a4', {})],
        ['no es un objeto', JSON.stringify([1, 2])],
        ['no trae data', JSON.stringify({ type: 'dispatch.delivery_complaint.received', messageId: 'a5' })],
        ['no trae messageId', JSON.stringify({ type: 'dispatch.delivery_complaint.received', data: { correlationMessageId: 'm' } })],
    ])('descarta lo que %s', (_name, raw) => {
        expect(parseAck(raw)).toBeUndefined();
    });
});

describe('deadLetteredMessageId', () => {
    it('devuelve el messageId del mensaje original del dead-letter', () => {
        const raw = JSON.stringify({ originalTopic: 't', rejectedAt: 'x', errors: [], message: { messageId: 'orig-1' } });
        expect(deadLetteredMessageId(raw)).toBe('orig-1');
    });

    it.each([
        ['no es JSON', 'xx'],
        ['el original no es un objeto', JSON.stringify({ message: 'texto' })],
        ['el original no tiene messageId', JSON.stringify({ message: { type: 'x' } })],
        ['no hay mensaje original', JSON.stringify({ originalTopic: 't' })],
    ])('devuelve undefined si %s', (_name, raw) => {
        expect(deadLetteredMessageId(raw)).toBeUndefined();
    });
});

describe('judgeAck', () => {
    it('received esperado y recibido: bien', () => {
        expect(judgeAck({ outcome: 'received' }, [received()])).toEqual({ ok: true, summary: 'received' });
    });

    it('rejected esperado con su código: bien', () => {
        expect(
            judgeAck({ outcome: 'rejected', rejectionCode: 'dispatch_not_found' }, [rejected('dispatch_not_found')]),
        ).toEqual({ ok: true, summary: 'rejected/dispatch_not_found' });
    });

    it('schema_invalid con el campo esperado: bien', () => {
        const verdict = judgeAck({ outcome: 'rejected', rejectionCode: 'schema_invalid', field: '/data/affectedItems' }, [
            rejected('schema_invalid', { field: '/data/affectedItems' }),
        ]);
        expect(verdict.ok).toBe(true);
    });

    it('ignored sin ningún acuse: bien', () => {
        expect(judgeAck({ outcome: 'ignored' }, []).ok).toBe(true);
    });

    it.each([
        ['no llegó nada', { outcome: 'received' as const }, [], 'no llegó el acuse'],
        ['llegó otro resultado', { outcome: 'received' as const }, [rejected('dispatch_not_found')], 'llegó rejected/dispatch_not_found'],
        [
            'llegó otro código',
            { outcome: 'rejected' as const, rejectionCode: 'dispatch_not_found' },
            [rejected('dispatch_not_delivered')],
            'llegó rejected/dispatch_not_delivered',
        ],
        [
            'llegó received y se esperaba rejected',
            { outcome: 'rejected' as const, rejectionCode: 'dispatch_not_found' },
            [received()],
            'llegó received',
        ],
        [
            'el campo es otro',
            { outcome: 'rejected' as const, rejectionCode: 'schema_invalid', field: '/data/affectedItems' },
            [rejected('schema_invalid', { field: '/data/caseVersion' })],
            'se esperaba el campo /data/affectedItems',
        ],
        [
            'faltó el campo',
            { outcome: 'rejected' as const, rejectionCode: 'schema_invalid', field: '/data/affectedItems' },
            [rejected('schema_invalid')],
            'se esperaba el campo /data/affectedItems',
        ],
        ['se esperaba ninguno y llegó uno', { outcome: 'ignored' as const }, [received()], 'se esperaba ningún acuse'],
    ])('falla si %s', (_name, expected, arrived, text) => {
        const verdict = judgeAck(expected, arrived);
        expect(verdict.ok).toBe(false);
        expect(verdict.summary).toContain(text);
    });

    it('la misma entrega repetida del acuse (mismo messageId) cuenta una sola vez', () => {
        expect(judgeAck({ outcome: 'received' }, [received('ack-1'), received('ack-1')]).ok).toBe(true);
    });

    it('dos acuses distintos para un mismo reclamo son un fallo, aunque uno sea el esperado', () => {
        const verdict = judgeAck({ outcome: 'received' }, [received('ack-1'), received('ack-2')]);
        expect(verdict.ok).toBe(false);
        expect(verdict.summary).toContain('2 acuses distintos');
    });
});

describe('judgeStep', () => {
    it('un paso que espera silencio no es concluyente si nada respondió antes (Despachos puede estar caído)', () => {
        const verdict = judgeStep({ outcome: 'ignored' }, [], { answeredBefore: false });
        expect(verdict.ok).toBe(false);
        expect(verdict.summary).toContain('no concluyente');
    });

    it('el mismo silencio vale una vez que un paso anterior recibió su acuse', () => {
        expect(judgeStep({ outcome: 'ignored' }, [], { answeredBefore: true }).ok).toBe(true);
    });

    it('un acuse que llegó donde se esperaba silencio es un fallo, haya o no respuestas previas', () => {
        expect(judgeStep({ outcome: 'ignored' }, [received()], { answeredBefore: true }).ok).toBe(false);
        expect(judgeStep({ outcome: 'ignored' }, [received()], { answeredBefore: false }).ok).toBe(false);
    });

    it('no cambia el veredicto de los pasos que sí esperan un acuse', () => {
        expect(judgeStep({ outcome: 'received' }, [received()], { answeredBefore: false }).ok).toBe(true);
        expect(judgeStep({ outcome: 'received' }, [], { answeredBefore: true }).ok).toBe(false);
    });
});
