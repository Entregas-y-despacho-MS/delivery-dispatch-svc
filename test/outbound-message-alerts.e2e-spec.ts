import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import {
  OUTBOUND_MESSAGE_DELAYED_ACTION,
  OUTBOUND_MESSAGE_FAILED_ACTION,
} from '../src/modules/messaging/outbound-messages/services/outbox-publisher.config.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';

describe('GET /audit/outbound-message-alerts (e2e, ST-73.1)', () => {
  let app: INestApplication;
  let db: DataSource;
  let prefix: string;
  let coordinatorToken: string;
  let driverToken: string;
  let coordinatorId: number;
  let driverId: number;
  const messageIds = [uuidv7(), uuidv7()];
  const auditIds: number[] = [];
  const userIds: number[] = [];
  const run = Date.now().toString(36);

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    prefix = app.get(AppConfig).apiPrefix;
    app.setGlobalPrefix(prefix);
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        transformOptions: { enableImplicitConversion: false },
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    db = moduleRef.get(DataSource);

    const [{ role_id: coordinatorRoleId }] = await db.query(
      `SELECT role_id FROM roles WHERE name = 'coordinator'`,
    );
    const [{ role_id: driverRoleId }] = await db.query(
      `SELECT role_id FROM roles WHERE name = 'driver'`,
    );
    const password = 'E2eTest1234';
    const passwordHash = await hashPassword(password);
    const users = await db.query(
      `INSERT INTO users (role_id, full_name, username, password_hash, active, requires_pwd_change)
       VALUES ($1, $2, $3, $4, TRUE, FALSE), ($5, $6, $7, $4, TRUE, FALSE)
       RETURNING user_id, username`,
      [
        coordinatorRoleId,
        `ST731 coordinator ${run}`,
        `st731_coord_${run}`,
        passwordHash,
        driverRoleId,
        `ST731 driver ${run}`,
        `st731_driver_${run}`,
      ],
    );
    coordinatorId = Number(users[0].user_id);
    driverId = Number(users[1].user_id);
    userIds.push(coordinatorId, driverId);

    const login = async (username: string): Promise<string> => {
      const response = await request(app.getHttpServer())
        .post(`/${prefix}/auth/login`)
        .send({ username, password });
      expect(response.status).toBe(200);
      return response.body.accessToken as string;
    };
    coordinatorToken = await login(users[0].username);
    driverToken = await login(users[1].username);

    for (const [index, messageId] of messageIds.entries()) {
      await db.query(
        `INSERT INTO outbound_messages (message_id, status, type, payload, attempts, next_attempt_at)
         VALUES ($1, $2, 'dispatch.shipment.departed', '{}'::jsonb, $3, NOW() + interval '1 day')`,
        [messageId, index === 0 ? 'pending' : 'failed', index === 0 ? 3 : 51],
      );
    }
    const first = await db.query(
      `INSERT INTO audit_logs (user_id, action, detail, created_at)
       VALUES (NULL, $1, $2, NOW() - interval '1 minute') RETURNING audit_log_id`,
      [
        OUTBOUND_MESSAGE_DELAYED_ACTION,
        JSON.stringify({
          messageId: messageIds[0],
          type: 'dispatch.shipment.departed',
          attempts: 3,
          lastError: 'broker unavailable',
        }),
      ],
    );
    const second = await db.query(
      `INSERT INTO audit_logs (user_id, action, detail, created_at)
       VALUES (NULL, $1, $2, NOW()) RETURNING audit_log_id`,
      [
        OUTBOUND_MESSAGE_FAILED_ACTION,
        JSON.stringify({
          messageId: messageIds[1],
          type: 'dispatch.shipment.departed',
          attempts: 51,
          lastError: 'broker timeout',
        }),
      ],
    );
    auditIds.push(
      Number(first[0].audit_log_id),
      Number(second[0].audit_log_id),
    );
  });

  afterAll(async () => {
    if (db?.isInitialized) {
      await db.query(
        `DELETE FROM audit_logs WHERE audit_log_id = ANY($1::int[])`,
        [auditIds],
      );
      await db.query(
        `DELETE FROM outbound_messages WHERE message_id = ANY($1::uuid[])`,
        [messageIds],
      );
      await db.query(`DELETE FROM users WHERE user_id = ANY($1::int[])`, [
        userIds,
      ]);
    }
    await app?.close();
  });

  const endpoint = () => `/${prefix}/audit/outbound-message-alerts`;

  it('requires authentication and coordinator permissions', async () => {
    const anonymous = await request(app.getHttpServer()).get(endpoint());
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error).toBe('INVALID_TOKEN');

    const driver = await request(app.getHttpServer())
      .get(endpoint())
      .set('Authorization', `Bearer ${driverToken}`);
    expect(driver.status).toBe(403);
    expect(driver.body.error).toBe('INSUFFICIENT_PERMISSIONS');
  });

  it('shows both alert types newest first with current outbox status and pagination', async () => {
    const limit = 100;
    const firstPage = await request(app.getHttpServer())
      .get(`${endpoint()}?page=1&limit=${limit}`)
      .set('Authorization', `Bearer ${coordinatorToken}`);

    expect(firstPage.status).toBe(200);
    expect(firstPage.body.meta).toMatchObject({ page: 1, limit });
    expect(firstPage.body.meta.total).toBeGreaterThanOrEqual(auditIds.length);
    expect(firstPage.body.meta.pages).toBe(
      Math.ceil(firstPage.body.meta.total / limit),
    );

    const alerts = [...firstPage.body.data];
    for (let page = 2; page <= firstPage.body.meta.pages; page++) {
      const response = await request(app.getHttpServer())
        .get(`${endpoint()}?page=${page}&limit=${limit}`)
        .set('Authorization', `Bearer ${coordinatorToken}`);
      expect(response.status).toBe(200);
      expect(response.body.meta).toMatchObject({ page, limit });
      alerts.push(...response.body.data);
    }

    const ownAlerts = alerts.filter((alert) => auditIds.includes(alert.id));
    expect(ownAlerts).toHaveLength(auditIds.length);
    expect(ownAlerts.map((alert) => alert.id)).toEqual([
      auditIds[1],
      auditIds[0],
    ]);
    expect(ownAlerts[0]).toMatchObject({
      action: OUTBOUND_MESSAGE_FAILED_ACTION,
      messageId: messageIds[1],
      messageType: 'dispatch.shipment.departed',
      attemptsAtAlert: 51,
      lastError: 'broker timeout',
      currentStatus: 'failed',
      currentAttempts: 51,
    });
    expect(ownAlerts[1]).toMatchObject({
      action: OUTBOUND_MESSAGE_DELAYED_ACTION,
      messageId: messageIds[0],
      currentStatus: 'pending',
    });
  });

  it('validates pagination parameters', async () => {
    const response = await request(app.getHttpServer())
      .get(`${endpoint()}?limit=101`)
      .set('Authorization', `Bearer ${coordinatorToken}`);
    expect(response.status).toBe(400);
  });
});
