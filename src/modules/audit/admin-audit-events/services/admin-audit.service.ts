import { HttpException, Injectable, Logger, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request } from 'express';
import { Repository } from 'typeorm';
import type { AuthUser } from '../../../../app/auth/strategies/jwt.strategy.js';
import { AUDIT_ACTION_KEY, type AuditActionMetadata } from '../decorators/audit-action.decorator.js';
import { buildAuditEvent, resultForStatus, type AdminAuditEvent } from '../domain/admin-audit-event.js';
import { AdminAuditEventEntity } from '../entities/admin-audit-event.entity.js';

/** Request after `correlationIdMiddleware` and the JWT strategy. */
export type AuditedRequest = Request & { correlationId?: string; user?: AuthUser; auditMetadata?: Record<string, unknown> };

/** The declared fields present in a body or query; anything that is not a plain object yields nothing. */
function pickFields(container: unknown, fields: readonly string[]): Record<string, unknown> {
    if (!container || typeof container !== 'object' || Array.isArray(container)) return {};
    const source = container as Record<string, unknown>;
    return Object.fromEntries(fields.filter((field) => Object.hasOwn(source, field)).map((field) => [field, source[field]]));
}

/**
 * Writes the audit events of the sensitive actions (RF-A35). Failure policy: recording never changes the business
 * result of the request (no method here throws), but a failure is never silent either: a failed write is logged as
 * an error with the whole event (it carries no secrets), so the missing row can be rebuilt from the log and the gap
 * in coverage is visible.
 */
@Injectable()
export class AdminAuditService {
    private readonly logger = new Logger(AdminAuditService.name);

    constructor(
        @InjectRepository(AdminAuditEventEntity) private readonly repo: Repository<AdminAuditEventEntity>,
        private readonly reflector: Reflector,
    ) {}

    /** The audit declaration of the handler about to run, or `null` when it is not a sensitive action. */
    auditedAction(context: ExecutionContext): AuditActionMetadata | null {
        if (context.getType() !== 'http') return null;
        return this.reflector.get<AuditActionMetadata | undefined>(AUDIT_ACTION_KEY, context.getHandler()) ?? null;
    }

    /**
     * Records the outcome of a request to a sensitive handler; `status` is the HTTP status it ended with and
     * `responseBody` what the handler returned (only read by actions that take the entity id from the response).
     */
    async recordOutcome(context: ExecutionContext, status: number, responseBody?: unknown): Promise<void> {
        let event: AdminAuditEvent;
        try {
            const declared = this.auditedAction(context);
            if (!declared) return;
            const request = context.switchToHttp().getRequest<AuditedRequest>();
            event = buildAuditEvent({
                action: declared.action,
                actor: request.user ? { id: request.user.id, role: request.user.role } : null,
                entityId: this.entityId(declared, request, responseBody),
                result: resultForStatus(status),
                statusCode: status,
                correlationId: request.correlationId,
                ip: request.ip,
                metadata: {
                    ...pickFields(request.query, declared.queryFields ?? []),
                    ...pickFields(request.body, declared.bodyFields ?? []),
                    ...request.auditMetadata,
                    ...declared.metadata,
                },
            });
        } catch (error) {
            this.logger.error({ event: 'admin_audit_build_failed', status, error: error instanceof Error ? error.name : 'unknown' });
            return;
        }
        await this.record(event);
    }

    /** The id of the affected entity according to the action's declared source; `null` when it cannot be known. */
    private entityId(declared: AuditActionMetadata, request: AuditedRequest, responseBody: unknown): string | null {
        switch (declared.entityIdFrom ?? 'param') {
            case 'actor':
                return request.user ? String(request.user.id) : null;
            case 'response': {
                const id = responseBody && typeof responseBody === 'object' ? (responseBody as { id?: unknown }).id : undefined;
                return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
            }
            default: {
                const name = declared.entityIdParam === undefined ? 'id' : declared.entityIdParam;
                const param = name ? request.params?.[name] : undefined;
                return typeof param === 'string' ? param : null;
            }
        }
    }

    /** Same as `recordOutcome`, from the error that ended the request. */
    async recordError(context: ExecutionContext, error: unknown): Promise<void> {
        await this.recordOutcome(context, error instanceof HttpException ? error.getStatus() : 500);
    }

    async record(event: AdminAuditEvent): Promise<boolean> {
        try {
            await this.repo.insert({
                id: event.eventId,
                actorUserId: event.actorId,
                actorRole: event.actorRole,
                action: event.action,
                entityType: event.entityType,
                entityId: event.entityId,
                result: event.result,
                statusCode: event.statusCode,
                correlationId: event.correlationId,
                ipAddress: event.ip,
                metadata: event.metadata,
                occurredAt: event.occurredAt,
            });
            return true;
        } catch (error) {
            this.logger.error({
                event: 'admin_audit_write_failed',
                error: error instanceof Error ? error.name : 'unknown',
                audit: { ...event, occurredAt: event.occurredAt.toISOString() },
            });
            return false;
        }
    }
}
