import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { RateDeliveryDto } from './rate-delivery.dto.js';

const validate = (comment: unknown) => validateSync(plainToInstance(RateDeliveryDto, { score: 5, comment }));

describe('RateDeliveryDto comment (ST-43.1)', () => {
    it('trims a plain-text comment before validating and storing it', () => {
        const dto = plainToInstance(RateDeliveryDto, { score: 5, comment: '  Bien entregado.  ' });

        expect(dto.comment).toBe('Bien entregado.');
        expect(validate('  Bien entregado.  ')).toHaveLength(0);
    });

    it('allows the comment to be omitted or blank', () => {
        expect(validate(undefined)).toHaveLength(0);
        const dto = plainToInstance(RateDeliveryDto, { score: 5, comment: '   ' });
        expect(dto.comment).toBeNull();
        expect(validate('   ')).toHaveLength(0);
    });

    it('rejects non-text comments and more than 500 characters after trimming', () => {
        expect(validate(123).some((error) => error.property === 'comment')).toBe(true);
        expect(validate(` ${'x'.repeat(501)} `).some((error) => error.property === 'comment')).toBe(true);
        expect(validate(` ${'x'.repeat(500)} `)).toHaveLength(0);
    });
});
