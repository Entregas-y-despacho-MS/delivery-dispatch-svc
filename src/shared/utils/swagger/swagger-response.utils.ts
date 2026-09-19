import { applyDecorators } from '@nestjs/common';
import {
    ApiNotFoundResponse, ApiBadRequestResponse, ApiUnauthorizedResponse,
    ApiForbiddenResponse, ApiConflictResponse, ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { ValidationExceptionDto } from '../../dto/index.js';

export interface ErrorExample {
    /** SCREAMING_SNAKE_CASE error code. Maps to the `error` field in the response body. */
    code:    string;
    message: string;
}

/**
 * Builds a concrete error response body — used in schema examples.
 */
export function errorBody(status: number, code: string, message: string) {
    return {
        statusCode: status,
        error:      code,
        message,
        path:       '/api/resource',
        timestamp:  '2026-01-01T00:00:00.000Z',
    };
}

/**
 * Builds the response schema options for one or many possible errors.
 *
 * - Single error  → schema.example  (shows one concrete body)
 * - Multiple errors → content.examples (Swagger UI shows a dropdown with each possible error code)
 */
function buildErrorResponse(status: number, errors: ErrorExample[]): object {
    if (errors.length === 1) {
        return {
            schema: { example: errorBody(status, errors[0].code, errors[0].message) },
        };
    }

    const examples: Record<string, { summary: string; value: object }> = {};
    for (const { code, message } of errors) {
        examples[code] = {
            summary: code,
            value:   errorBody(status, code, message),
        };
    }

    return {
        content: {
            'application/json': {
                schema: {
                    type: 'object',
                    properties: {
                        statusCode: { type: 'number',  example: status },
                        error:      { type: 'string',  description: `One of: ${errors.map(e => e.code).join(', ')}` },
                        message:    { type: 'string' },
                        path:       { type: 'string' },
                        timestamp:  { type: 'string', format: 'date-time' },
                    },
                },
                examples,
            },
        },
    };
}

// ── Decorators ─────────────────────────────────────────────────────────────

/**
 * 404 — Resource not found.
 * Pass one or more error examples to document all possible NOT_FOUND codes.
 *
 * @example
 * \@ApiNotFound({ code: 'USER_NOT_FOUND', message: 'User not found.' })
 * \@ApiNotFound(
 *   { code: 'USER_NOT_FOUND',  message: 'User not found.' },
 *   { code: 'ORDER_NOT_FOUND', message: 'Order not found.' },
 * )
 */
export const ApiNotFound = (...errors: ErrorExample[]) => {
    const list = errors.length ? errors : [{ code: 'NOT_FOUND', message: 'The requested resource was not found.' }];
    return applyDecorators(ApiNotFoundResponse({ description: 'Not found.', ...buildErrorResponse(404, list) }));
};

/**
 * 409 — Unique constraint violation.
 */
export const ApiConflict = (...errors: ErrorExample[]) => {
    const list = errors.length ? errors : [{ code: 'CONFLICT', message: 'A record with that data already exists.' }];
    return applyDecorators(ApiConflictResponse({ description: 'Conflict.', ...buildErrorResponse(409, list) }));
};

/**
 * 401 — Authentication failed.
 * Pass the specific code(s) this endpoint can return.
 */
export const ApiUnauthorized = (...errors: ErrorExample[]) => {
    const list = errors.length ? errors : [{ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' }];
    return applyDecorators(ApiUnauthorizedResponse({ description: 'Unauthorized.', ...buildErrorResponse(401, list) }));
};

/**
 * 403 — Authenticated but insufficient permissions.
 */
export const ApiForbidden = (...errors: ErrorExample[]) => {
    const list = errors.length ? errors : [{ code: 'INSUFFICIENT_PERMISSIONS', message: 'You do not have permission to perform this action.' }];
    return applyDecorators(ApiForbiddenResponse({ description: 'Forbidden.', ...buildErrorResponse(403, list) }));
};

/** 400 — Body or query params failed ValidationPipe. The message field is an array of field errors. */
export const ApiValidationError = () =>
    applyDecorators(ApiBadRequestResponse({ description: 'Validation failed.', type: ValidationExceptionDto }));

/**
 * 422 — Data is structurally valid but cannot be processed in the current state.
 */
export const ApiUnprocessableEntity = (...errors: ErrorExample[]) => {
    const list = errors.length ? errors : [{ code: 'UNPROCESSABLE_ENTITY', message: 'Data cannot be processed in its current state.' }];
    return applyDecorators(ApiUnprocessableEntityResponse({ description: 'Unprocessable entity.', ...buildErrorResponse(422, list) }));
};
