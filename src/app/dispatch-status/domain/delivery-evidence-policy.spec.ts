import { describe, expect, it } from 'vitest';
import { DispatchEvidenceInvalidException } from '../exceptions/dispatch-evidence-invalid.exception.js';
import { DispatchEvidenceRequiredException } from '../exceptions/dispatch-evidence-required.exception.js';
import type { DeliveryEvidenceType } from '../dto/delivery-evidence-ref.dto.js';
import { assertDeliveryEvidence, requiredEvidenceType, type StoredEvidence } from './delivery-evidence-policy.js';

const ID = '01933b6e-7f2a-7c3d-9a1b-2f8e6c4d5a11';

function stored(type: DeliveryEvidenceType, override: Partial<StoredEvidence> = {}): StoredEvidence {
    return {
        id: ID, dispatchId: 7, type,
        fileUrl: type === 'otp' ? null : 'https://files.test/e.bin',
        capturedAt: new Date('2026-11-23T10:00:00Z'),
        receiverName: type === 'signature' ? 'Maria Lopez' : null,
        receiverDocument: type === 'signature' ? '1234567' : null,
        ...override,
    };
}

function check(policy: string, type: DeliveryEvidenceType, record: StoredEvidence | null, withReference = true): void {
    assertDeliveryEvidence({ dispatchId: 7, policy, reference: withReference ? { evidenceId: ID, type } : undefined, stored: record });
}

function codeOf(fn: () => void): string {
    try { fn(); } catch (err) { return ((err as { getResponse(): { error: string } }).getResponse()).error; }
    return 'NO_ERROR';
}

describe('requiredEvidenceType', () => {
    it.each([
        ['hand_delivery_standard', 'signature'],
        ['contactless_delivery', 'photo'],
        ['high_value_control', 'otp'],
    ])('%s requires %s', (policy, type) => expect(requiredEvidenceType(policy)).toBe(type));

    it('knows no type for an unknown policy', () => expect(requiredEvidenceType('anything')).toBeUndefined());
});

describe('assertDeliveryEvidence', () => {
    it.each([
        ['hand_delivery_standard', 'signature'],
        ['contactless_delivery', 'photo'],
        ['high_value_control', 'otp'],
    ] as const)('accepts complete %s evidence of type %s', (policy, type) => {
        expect(() => check(policy, type, stored(type))).not.toThrow();
    });

    it('requires a reference', () => {
        expect(() => check('contactless_delivery', 'photo', null, false)).toThrow(DispatchEvidenceRequiredException);
    });

    it('refuses an unknown policy even with a reference', () => {
        expect(() => check('mystery', 'photo', stored('photo'))).toThrow(DispatchEvidenceRequiredException);
    });

    it('rejects an evidence id with no record', () => {
        expect(codeOf(() => check('contactless_delivery', 'photo', null))).toBe('DISPATCH_EVIDENCE_NOT_FOUND');
    });

    it('rejects evidence of another dispatch', () => {
        expect(codeOf(() => check('contactless_delivery', 'photo', stored('photo', { dispatchId: 8 })))).toBe('DISPATCH_EVIDENCE_FOREIGN');
    });

    it.each([
        ['hand_delivery_standard', 'photo'],
        ['contactless_delivery', 'signature'],
        ['high_value_control', 'signature'],
        ['high_value_control', 'photo'],
    ] as const)('policy %s cannot be satisfied with %s', (policy, type) => {
        expect(codeOf(() => check(policy, type, stored(type)))).toBe('DISPATCH_EVIDENCE_TYPE_MISMATCH');
    });

    it('rejects a reference whose type disagrees with the stored record', () => {
        expect(codeOf(() => check('contactless_delivery', 'photo', stored('signature')))).toBe('DISPATCH_EVIDENCE_TYPE_MISMATCH');
    });

    it.each([
        ['photo', { fileUrl: null }],
        ['photo', { fileUrl: '  ' }],
        ['photo', { capturedAt: null }],
        ['signature', { fileUrl: null }],
        ['signature', { receiverName: null }],
        ['signature', { receiverDocument: ' ' }],
    ] as const)('rejects incomplete %s evidence (%j)', (type, override) => {
        const policy = type === 'photo' ? 'contactless_delivery' : 'hand_delivery_standard';
        expect(codeOf(() => check(policy, type, stored(type, override)))).toBe('DISPATCH_EVIDENCE_INCOMPLETE');
    });

    it('raises the typed exception class for invalid evidence', () => {
        expect(() => check('contactless_delivery', 'photo', null)).toThrow(DispatchEvidenceInvalidException);
    });
});
