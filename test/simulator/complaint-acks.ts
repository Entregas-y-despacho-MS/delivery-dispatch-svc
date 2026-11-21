import type { ExpectedAck } from './scenario.types.js';

/**
 * Reading of what Despachos answers to a CRM complaint (ST-298.4). It is pure: `scripts/simulator/` feeds it
 * the messages it receives from the emulator and the tests feed it the same shapes, so the verdict printed
 * by `npm run simulate:crm` is the one the tests check.
 */
export const RECEIVED_TOPIC = 'dispatch.delivery_complaint.received';
export const REJECTED_TOPIC = 'dispatch.delivery_complaint.rejected';

export interface ObservedAck {
    outcome: 'received' | 'rejected';
    /** `messageId` of the acknowledgement itself (the outbox may deliver it more than once). */
    messageId: string;
    /** `messageId` of the complaint it answers. */
    correlationMessageId: string;
    crmCaseId?: string;
    caseVersion?: number;
    rejectionCode?: string;
    field?: string;
}

export interface Verdict {
    ok: boolean;
    /** One line for the console: what arrived, or what was missing. */
    summary: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** `undefined` when the body is not an acknowledgement of a complaint (another topic, not JSON, no correlation). */
export function parseAck(raw: string): ObservedAck | undefined {
    let body: unknown;
    try {
        body = JSON.parse(raw);
    } catch {
        return undefined;
    }
    if (!isRecord(body) || !isRecord(body['data'])) return undefined;
    const outcome =
        body['type'] === RECEIVED_TOPIC ? 'received' : body['type'] === REJECTED_TOPIC ? 'rejected' : undefined;
    const data = body['data'];
    if (outcome === undefined || typeof body['messageId'] !== 'string') return undefined;
    if (typeof data['correlationMessageId'] !== 'string') return undefined;
    return {
        outcome,
        messageId: body['messageId'],
        correlationMessageId: data['correlationMessageId'],
        ...(typeof data['crmCaseId'] === 'string' ? { crmCaseId: data['crmCaseId'] } : {}),
        ...(typeof data['caseVersion'] === 'number' ? { caseVersion: data['caseVersion'] } : {}),
        ...(typeof data['rejectionCode'] === 'string' ? { rejectionCode: data['rejectionCode'] } : {}),
        ...(typeof data['field'] === 'string' ? { field: data['field'] } : {}),
    };
}

/** `messageId` of the complaint a dead-letter message carries (`DeadLetterPayload.message`), if it has one. */
export function deadLetteredMessageId(raw: string): string | undefined {
    try {
        const body: unknown = JSON.parse(raw);
        const original = isRecord(body) ? body['message'] : undefined;
        return isRecord(original) && typeof original['messageId'] === 'string' ? original['messageId'] : undefined;
    } catch {
        return undefined;
    }
}

const describeAck = (ack: ObservedAck): string =>
    ack.outcome === 'received'
        ? 'received'
        : `rejected/${ack.rejectionCode ?? '?'}${ack.field !== undefined ? ` (${ack.field})` : ''}`;

/**
 * Compares the acknowledgements that arrived for ONE complaint with what the scenario expects. Repeated
 * deliveries of the same acknowledgement (same `messageId`, the outbox retries) count once.
 */
export function judgeAck(expected: ExpectedAck, arrived: ObservedAck[]): Verdict {
    const acks = [...new Map(arrived.map((ack) => [ack.messageId, ack])).values()];

    if (expected.outcome === 'ignored') {
        return acks.length === 0
            ? { ok: true, summary: 'sin acuse, como se esperaba (versión repetida o atrasada)' }
            : { ok: false, summary: `se esperaba ningún acuse y llegó ${acks.map(describeAck).join(' + ')}` };
    }

    const wanted = expected.outcome === 'received' ? 'received' : `rejected/${expected.rejectionCode ?? '?'}`;
    if (acks.length === 0) return { ok: false, summary: `no llegó el acuse (se esperaba ${wanted})` };
    if (acks.length > 1) {
        return { ok: false, summary: `llegaron ${acks.length} acuses distintos: ${acks.map(describeAck).join(' + ')}` };
    }

    const ack = acks[0]!;
    if (ack.outcome !== expected.outcome) {
        return { ok: false, summary: `llegó ${describeAck(ack)} y se esperaba ${wanted}` };
    }
    if (expected.outcome === 'rejected') {
        if (ack.rejectionCode !== expected.rejectionCode) {
            return { ok: false, summary: `llegó ${describeAck(ack)} y se esperaba ${wanted}` };
        }
        if (expected.field !== undefined && ack.field !== expected.field) {
            return {
                ok: false,
                summary: `llegó ${describeAck(ack)} y se esperaba el campo ${expected.field}`,
            };
        }
    }
    return { ok: true, summary: describeAck(ack) };
}
