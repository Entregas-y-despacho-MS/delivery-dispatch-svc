import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { AssignComplaintCaseDto, IssueComplaintVerdictDto } from './complaint-case-commands.dto.js';

const valid = { expectedVersion: 1, verdict: 'not_confirmed', decisionReason: 'No damage found.', findings: 'The photos show an intact package.' };

async function errorsOf(plain: Record<string, unknown>): Promise<string[]> {
    const dto = plainToInstance(IssueComplaintVerdictDto, plain);
    return (await validate(dto)).flatMap((error) => Object.values(error.constraints ?? {}));
}

describe('IssueComplaintVerdictDto', () => {
    it('accepts each of the three verdicts and nothing else', async () => {
        for (const verdict of ['no_return_required', 'request_RMA', 'not_confirmed']) {
            expect(await errorsOf({ ...valid, verdict })).toEqual([]);
        }
        for (const verdict of ['refund', 'restock', 'close', 'REQUEST_RMA', '', null]) {
            expect(await errorsOf({ ...valid, verdict })).toContain('verdict must be one of: no_return_required, request_RMA, not_confirmed.');
        }
    });

    it('requires the reason and the findings, also when they are only blanks', async () => {
        expect(await errorsOf({ ...valid, decisionReason: undefined })).not.toEqual([]);
        expect(await errorsOf({ ...valid, findings: undefined })).not.toEqual([]);
        expect(await errorsOf({ ...valid, decisionReason: '   ' })).toContain('decisionReason must not be empty.');
        expect(await errorsOf({ ...valid, findings: ' \n\t ' })).toContain('findings must not be empty.');
    });

    it('limits the reason to 500 characters and the findings to 4000', async () => {
        expect(await errorsOf({ ...valid, decisionReason: 'a'.repeat(500) })).toEqual([]);
        expect(await errorsOf({ ...valid, decisionReason: 'a'.repeat(501) })).toContain('decisionReason must not exceed 500 characters.');
        expect(await errorsOf({ ...valid, findings: 'a'.repeat(4000) })).toEqual([]);
        expect(await errorsOf({ ...valid, findings: 'a'.repeat(4001) })).toContain('findings must not exceed 4000 characters.');
    });

    it('rejects links in the reason and in the findings: evidence is referenced, never published', async () => {
        expect(await errorsOf({ ...valid, findings: 'See https://files.example.com/photo.jpg' })).toContain('findings must not contain links.');
        expect(await errorsOf({ ...valid, decisionReason: 'Proof at www.example.com' })).toContain('decisionReason must not contain links.');
        expect(await errorsOf({ ...valid, findings: 'See\nHTTP://x.example' })).toContain('findings must not contain links.');
    });

    it('strips control characters and trims what it keeps', () => {
        const dto = plainToInstance(IssueComplaintVerdictDto, { ...valid, findings: '  Cracked\u0007 casing.\nSecond line.  ' });

        expect(dto.findings).toBe('Cracked casing.\nSecond line.');
    });

    it('requires a whole expectedVersion between 1 and the INTEGER limit', async () => {
        expect(await errorsOf({ ...valid, expectedVersion: 0 })).toContain('expectedVersion must be >= 1.');
        expect(await errorsOf({ ...valid, expectedVersion: 1.5 })).toContain('expectedVersion must be an integer.');
        expect(await errorsOf({ ...valid, expectedVersion: 2147483648 })).toContain('expectedVersion must be <= 2147483647.');
        expect(await errorsOf({ ...valid, expectedVersion: undefined })).not.toEqual([]);
    });
});

describe('AssignComplaintCaseDto', () => {
    it('the assignee is optional but, when sent, a valid user id', async () => {
        const check = async (plain: Record<string, unknown>) =>
            (await validate(plainToInstance(AssignComplaintCaseDto, plain))).flatMap((error) => Object.values(error.constraints ?? {}));

        expect(await check({ expectedVersion: 1 })).toEqual([]);
        expect(await check({ expectedVersion: 1, assigneeUserId: 9 })).toEqual([]);
        expect(await check({ expectedVersion: 1, assigneeUserId: 0 })).toContain('assigneeUserId must be >= 1.');
        expect(await check({ expectedVersion: 1, assigneeUserId: 'x' })).not.toEqual([]);
    });
});
