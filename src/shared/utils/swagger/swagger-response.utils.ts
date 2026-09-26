import { applyDecorators } from '@nestjs/common';
import {
    ApiParam,
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
 * 400 — Request is structurally valid but rejected by a business rule (not ValidationPipe).
 * Pass the specific code(s) this endpoint can return.
 */
export const ApiBadRequest = (...errors: ErrorExample[]) => {
    const list = errors.length ? errors : [{ code: 'BAD_REQUEST', message: 'The request could not be processed.' }];
    return applyDecorators(ApiBadRequestResponse({ description: 'Bad request.', ...buildErrorResponse(400, list) }));
};

export interface BadRequestOptions {
    /** The endpoint has a body or query params checked by ValidationPipe (message is an array). */
    validation?: boolean;
    /** The messages shown in the validation example — pick ones this endpoint can really return. */
    example?:    string[];
    /** The endpoint has a numeric `:id` path param (ParseIdPipe rejects a non-numeric or out-of-range value). */
    id?:         boolean;
    /** Business-rule rejections specific to this endpoint (message is a string, `error` a domain code). */
    errors?:     ErrorExample[];
}

/**
 * 400 — every way an endpoint can answer 400, documented in ONE response.
 *
 * Several `@Api*Response(400)` decorators on the same operation overwrite each other, so an
 * endpoint that can fail validation AND a business rule must use this instead of stacking
 * `ApiValidationError` + `ApiBadRequest`.
 */
export const ApiBadRequests = ({ validation = false, example, id = false, errors = [] }: BadRequestOptions) => {
    const examples: Record<string, { summary: string; value: object }> = {};
    const codes: string[] = [];
    if (validation) {
        codes.push('Bad Request');
        examples['VALIDATION_FAILED'] = {
            summary: 'A field is invalid — one message per problem (message is an array)',
            value: { ...errorBody(400, 'Bad Request', 'x'), message: example ?? ['A field is invalid.'] },
        };
    }
    if (id) {
        codes.push('Bad Request');
        examples['INVALID_ID'] = {
            summary: 'The :id in the URL is not a number (message is a string)',
            value: errorBody(400, 'Bad Request', 'Validation failed (numeric string is expected)'),
        };
    }
    for (const { code, message } of errors) {
        codes.push(code);
        examples[code] = { summary: `${code} — business rule (message is a string)`, value: errorBody(400, code, message) };
    }
    return applyDecorators(ApiBadRequestResponse({
        description: 'Bad request.',
        content: {
            'application/json': {
                schema: {
                    type: 'object',
                    properties: {
                        statusCode: { type: 'integer', example: 400 },
                        error:      { type: 'string', description: `One of: ${codes.join(', ')}` },
                        message:    { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'An array of field errors on validation failures, a single text otherwise.' },
                        path:       { type: 'string' },
                        timestamp:  { type: 'string', format: 'date-time' },
                    },
                },
                examples,
            },
        },
    }));
};

/**
 * 422 — Data is structurally valid but cannot be processed in the current state.
 */
export const ApiUnprocessableEntity = (...errors: ErrorExample[]) => {
    const list = errors.length ? errors : [{ code: 'UNPROCESSABLE_ENTITY', message: 'Data cannot be processed in its current state.' }];
    return applyDecorators(ApiUnprocessableEntityResponse({ description: 'Unprocessable entity.', ...buildErrorResponse(422, list) }));
};

/** Documents the numeric `:id` path param. `what` is the resource, e.g. 'Vehicle'. */
export const ApiIdParam = (what: string) =>
    applyDecorators(ApiParam({ name: 'id', type: 'integer', example: 1, description: `${what} ID (a whole number from 1 to 2147483647, as returned by the list endpoint). Anything else is a 400.` }));
