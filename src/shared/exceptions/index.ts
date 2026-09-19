/**
 * Exception guide for this template.
 *
 * Level 1 — Generic exceptions: use NestJS built-ins when the message is enough.
 *   throw new NotFoundException('Resource not found.');
 *   throw new BadRequestException('Email already in use.');
 *   throw new UnauthorizedException('Invalid or expired token.');
 *   throw new ForbiddenException('Insufficient permissions.');
 *   throw new ConflictException('A record with that value already exists.');
 *
 *   Response: { statusCode: 404, error: 'NOT_FOUND', message: '...', path, timestamp }
 *
 * Level 2 — Domain exceptions: use when the client needs a machine-readable error code
 * to distinguish between errors with the same HTTP status.
 *
 *   // In modules/my-module/exceptions/my-entity-not-found.exception.ts:
 *   export class MyEntityNotFoundException extends NotFoundException {
 *       constructor() {
 *           super({ message: 'My entity was not found.', error: 'MY_ENTITY_NOT_FOUND' });
 *       }
 *   }
 *
 *   // Response: { statusCode: 404, error: 'MY_ENTITY_NOT_FOUND', ... }
 *
 * Error code naming convention — always SCREAMING_SNAKE_CASE in English:
 *   ENTITY_ACTION  → USER_NOT_FOUND, ORDER_NOT_FOUND
 *   ENTITY_STATE   → ITEM_NOT_AVAILABLE, STOCK_EXCEEDED
 *   ACTION_CONTEXT → DUPLICATE_ITEM_IN_ORDER
 *
 * Domain exceptions live inside their own module (modules/X/exceptions/), not here.
 */

// This barrel exists for shared exceptions if ever needed.
// Domain exceptions go in their own module (modules/X/exceptions/).
