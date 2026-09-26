import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

const NUL = '\u0000';

/**
 * Registered globally (APP_PIPE). Postgres cannot store the NUL character in text, so a value that
 * carries one (body, query or path param) used to crash the query as a 500.
 */
@Injectable()
export class NoNullBytesPipe implements PipeTransform {
    transform(value: unknown, metadata: ArgumentMetadata): unknown {
        if (metadata.type !== 'body' && metadata.type !== 'query' && metadata.type !== 'param') return value;
        if (containsNul(value)) throw new BadRequestException('Text values cannot contain null characters.');
        return value;
    }
}

function containsNul(value: unknown, depth = 0): boolean {
    if (typeof value === 'string') return value.includes(NUL);
    if (depth > 20 || value === null || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some((item) => containsNul(item, depth + 1));
    return Object.entries(value as Record<string, unknown>).some(([key, item]) => key.includes(NUL) || containsNul(item, depth + 1));
}
