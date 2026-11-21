// Shared bootstrap of the e2e files that check the audit trail (RF-A35) of a family of sensitive handlers: the real
// AppModule, one throwaway user per role (logged in for real), and a way to read the audit rows of a request by its
// X-Request-Id. Everything it creates is deleted in `close()`.
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { AppConfig } from '../../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../../src/shared/filters/index.js';
import { hashPassword } from '../../src/shared/utils/crypto.util.js';

export interface AuditRow {
    admin_audit_event_id: string;
    actor_user_id: number | null;
    actor_role: string | null;
    action: string;
    entity_type: string | null;
    entity_id: string | null;
    result: string;
    status_code: number | null;
    correlation_id: string;
    metadata: Record<string, unknown>;
}

export type AuditRoleKey = 'admin' | 'coordinator' | 'supervisor' | 'driver';

export class AuditE2eHarness {
    app!: INestApplication;
    db!: DataSource;
    api = '';
    readonly password = 'E2eAudit1234!';
    readonly prefix: string;
    readonly roles: Record<string, number> = {};
    readonly users = {} as Record<AuditRoleKey, { id: number; username: string; token: string }>;
    private sequence = 0;

    constructor(tag: string) {
        this.prefix = `e2e-${tag}-${Date.now().toString(36)}`;
    }

    correlation(): string {
        return `${this.prefix}-${++this.sequence}`;
    }

    async start(keys: readonly AuditRoleKey[] = ['admin', 'coordinator']): Promise<void> {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        this.app = moduleRef.createNestApplication();
        this.api = this.app.get(AppConfig).apiPrefix;
        this.app.setGlobalPrefix(this.api);
        this.app.useGlobalPipes(new ValidationPipe({
            transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: false },
        }));
        this.app.useGlobalFilters(new HttpExceptionFilter());
        await this.app.init();
        this.db = moduleRef.get(DataSource);

        for (const row of await this.db.query('SELECT role_id, name FROM roles')) this.roles[row.name] = row.role_id;
        const hash = await hashPassword(this.password);
        for (const key of keys) {
            const username = `${this.prefix}-${key}`;
            const [{ user_id }] = await this.db.query(
                `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1, $2, $3, $4, false) RETURNING user_id`,
                [this.roles[key], `E2E audit ${key}`, username, hash],
            );
            this.users[key] = { id: user_id, username, token: await this.login(username, this.password) };
        }
    }

    async login(username: string, password: string): Promise<string> {
        const res = await request(this.app.getHttpServer()).post(`/${this.api}/auth/login`).send({ username, password });
        return res.body.accessToken as string;
    }

    /** Sends a request with the actor's token (none: no Authorization header) and a fresh correlation id. */
    call(method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, token: string | null, body?: object) {
        const correlationId = this.correlation();
        let call = request(this.app.getHttpServer())[method](`/${this.api}${path}`).set('X-Request-Id', correlationId);
        if (token) call = call.set('Authorization', `Bearer ${token}`);
        if (body) call = call.send(body);
        return { correlationId, response: call };
    }

    async eventsOf(correlationId: string): Promise<AuditRow[]> {
        return await this.db.query('SELECT * FROM admin_audit_events WHERE correlation_id = $1', [correlationId]);
    }

    async close(): Promise<void> {
        if (this.db?.isInitialized) {
            await this.db.query('DELETE FROM admin_audit_events WHERE correlation_id LIKE $1', [`${this.prefix}-%`]);
            await this.db.query('DELETE FROM users WHERE username LIKE $1', [`${this.prefix}-%`]);
        }
        await this.app?.close();
    }
}
