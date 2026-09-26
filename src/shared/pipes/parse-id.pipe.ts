import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { INT4_MAX } from '../constants/int4.js';

/**
 * `:id` path param: a whole number from 1 to the INTEGER maximum. Stricter than ParseIntPipe, which
 * accepted "1.5" and "1e3" (reading them as 1 and 1000) and let 0, negatives and numbers above the
 * INTEGER range through: the last ones failed inside Postgres as a 500.
 */
@Injectable()
export class ParseIdPipe implements PipeTransform<string | number, number> {
    // The global ValidationPipe (transform: true) runs first and may already have turned "12" into 12.
    transform(value: string | number): number {
        const raw = typeof value === 'number' ? String(value) : value;
        if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
            throw new BadRequestException('Validation failed (numeric string is expected)');
        }
        const id = Number(raw);
        if (id < 1 || id > INT4_MAX) {
            throw new BadRequestException(`Validation failed (id must be an integer between 1 and ${INT4_MAX})`);
        }
        return id;
    }
}
