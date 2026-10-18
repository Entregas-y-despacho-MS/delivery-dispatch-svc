import { describe, expect, it, vi } from 'vitest';
import { AuditLog } from '../entities/audit-log.entity.js';
import { OutboundMessage } from '../../../messaging/outbound-messages/entities/outbound-message.entity.js';
import {
  OUTBOUND_MESSAGE_DELAYED_ACTION,
  OUTBOUND_MESSAGE_FAILED_ACTION,
} from '../../../messaging/outbound-messages/services/outbox-publisher.config.js';
import { AuditLogsService } from './audit-logs.service.js';

describe('AuditLogsService.findOutboundMessageAlerts', () => {
  it('returns paginated outbox alerts newest first with the current message state', async () => {
    const messageId = '01933b6e-7f2a-7c3d-9a1b-2f8e6c4d5a10';
    const alert = {
      id: 8,
      action: OUTBOUND_MESSAGE_DELAYED_ACTION,
      createdAt: new Date('2026-10-18T11:00:00.000Z'),
      detail: JSON.stringify({
        messageId,
        type: 'dispatch.shipment.departed',
        attempts: 3,
        lastError: 'broker down',
      }),
    } as AuditLog;
    const auditLogs = {
      findAndCount: vi.fn().mockResolvedValue([[alert], 12]),
    };
    const currentMessage = {
      messageId,
      status: 'sent',
      attempts: 4,
    } as OutboundMessage;
    const outboundMessages = {
      find: vi.fn().mockResolvedValue([currentMessage]),
    };
    const service = new AuditLogsService(
      auditLogs as never,
      outboundMessages as never,
    );

    const result = await service.findOutboundMessageAlerts({
      page: 2,
      limit: 5,
    });

    expect(auditLogs.findAndCount).toHaveBeenCalledWith({
      where: { action: expect.objectContaining({ _type: 'in' }) },
      order: { createdAt: 'DESC', id: 'DESC' },
      skip: 5,
      take: 5,
    });
    expect(outboundMessages.find).toHaveBeenCalledOnce();
    expect(result).toEqual({
      data: [
        {
          id: 8,
          action: OUTBOUND_MESSAGE_DELAYED_ACTION,
          createdAt: alert.createdAt,
          messageId,
          messageType: 'dispatch.shipment.departed',
          attemptsAtAlert: 3,
          lastError: 'broker down',
          currentStatus: 'sent',
          currentAttempts: 4,
        },
      ],
      meta: { page: 2, limit: 5, total: 12, pages: 3 },
    });
  });

  it('handles malformed legacy detail and a message that no longer exists', async () => {
    const alert = {
      id: 9,
      action: OUTBOUND_MESSAGE_FAILED_ACTION,
      createdAt: new Date('2026-10-18T12:00:00.000Z'),
      detail: '{broken',
    } as AuditLog;
    const auditLogs = { findAndCount: vi.fn().mockResolvedValue([[alert], 1]) };
    const outboundMessages = { find: vi.fn() };
    const service = new AuditLogsService(
      auditLogs as never,
      outboundMessages as never,
    );

    const result = await service.findOutboundMessageAlerts({
      page: 1,
      limit: 10,
    });

    expect(outboundMessages.find).not.toHaveBeenCalled();
    expect(result.data[0]).toMatchObject({
      id: 9,
      action: OUTBOUND_MESSAGE_FAILED_ACTION,
      messageId: null,
      messageType: null,
      attemptsAtAlert: null,
      lastError: null,
      currentStatus: null,
      currentAttempts: null,
    });
    expect(result.meta).toEqual({ page: 1, limit: 10, total: 1, pages: 1 });
  });

  it('truncates broker errors to 500 characters before returning them', async () => {
    const alert = {
      id: 10,
      action: OUTBOUND_MESSAGE_FAILED_ACTION,
      createdAt: new Date('2026-10-18T12:00:00.000Z'),
      detail: JSON.stringify({ lastError: 'x'.repeat(700) }),
    } as AuditLog;
    const auditLogs = { findAndCount: vi.fn().mockResolvedValue([[alert], 1]) };
    const outboundMessages = { find: vi.fn() };
    const service = new AuditLogsService(
      auditLogs as never,
      outboundMessages as never,
    );

    const result = await service.findOutboundMessageAlerts({
      page: 1,
      limit: 10,
    });

    expect(result.data[0].lastError).toHaveLength(500);
  });

  it('returns an empty page without querying outbox messages', async () => {
    const auditLogs = { findAndCount: vi.fn().mockResolvedValue([[], 0]) };
    const outboundMessages = { find: vi.fn() };
    const service = new AuditLogsService(
      auditLogs as never,
      outboundMessages as never,
    );

    await expect(
      service.findOutboundMessageAlerts({ page: 1, limit: 10 }),
    ).resolves.toEqual({
      data: [],
      meta: { page: 1, limit: 10, total: 0, pages: 0 },
    });
    expect(outboundMessages.find).not.toHaveBeenCalled();
  });
});
