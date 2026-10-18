import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  PaginationParamsDto,
  PaginationResponseDto,
} from '../../../../shared/dto/index.js';
import { OutboundMessage } from '../../../messaging/outbound-messages/entities/outbound-message.entity.js';
import { AuditLog } from '../entities/audit-log.entity.js';
import { OutboundMessageAlertDto } from '../dto/outbound-message-alert.dto.js';
import {
  OUTBOUND_MESSAGE_DELAYED_ACTION,
  OUTBOUND_MESSAGE_FAILED_ACTION,
} from '../../../messaging/outbound-messages/services/outbox-publisher.config.js';

interface AlertDetail {
  messageId?: unknown;
  type?: unknown;
  attempts?: unknown;
  lastError?: unknown;
}

const OUTBOUND_ALERT_LAST_ERROR_MAX_LENGTH = 500;

const parseDetail = (detail: string | null): AlertDetail => {
  if (!detail) return {};
  try {
    const parsed: unknown = JSON.parse(detail);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as AlertDetail)
      : {};
  } catch {
    return {};
  }
};

const isUuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );

@Injectable()
export class AuditLogsService {
  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
    @InjectRepository(OutboundMessage)
    private readonly outboundMessages: Repository<OutboundMessage>,
  ) {}

  async findOutboundMessageAlerts(
    params: PaginationParamsDto,
  ): Promise<PaginationResponseDto<OutboundMessageAlertDto>> {
    const page = params.page ?? 1;
    const limit = params.limit ?? 10;
    const [alerts, total] = await this.auditLogs.findAndCount({
      where: {
        action: In([
          OUTBOUND_MESSAGE_DELAYED_ACTION,
          OUTBOUND_MESSAGE_FAILED_ACTION,
        ]),
      },
      order: { createdAt: 'DESC', id: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    const details = alerts.map(({ detail }) => parseDetail(detail));
    const messageIds = [
      ...new Set(details.map(({ messageId }) => messageId).filter(isUuid)),
    ];
    const messages = messageIds.length
      ? await this.outboundMessages.find({
          where: { messageId: In(messageIds) },
        })
      : [];
    const messagesById = new Map(
      messages.map((message) => [message.messageId, message]),
    );
    const data = alerts.map((alert, index) => {
      const detail = details[index];
      const messageId =
        typeof detail.messageId === 'string' ? detail.messageId : null;
      const currentMessage = messageId
        ? messagesById.get(messageId)
        : undefined;
      return {
        id: alert.id,
        action: alert.action,
        createdAt: alert.createdAt,
        messageId,
        messageType: typeof detail.type === 'string' ? detail.type : null,
        attemptsAtAlert:
          typeof detail.attempts === 'number' ? detail.attempts : null,
        lastError:
          typeof detail.lastError === 'string'
            ? detail.lastError.slice(0, OUTBOUND_ALERT_LAST_ERROR_MAX_LENGTH)
            : null,
        currentStatus: currentMessage?.status ?? null,
        currentAttempts: currentMessage?.attempts ?? null,
      } satisfies OutboundMessageAlertDto;
    });

    return {
      data,
      meta: {
        page,
        limit,
        total,
        pages: total === 0 ? 0 : Math.ceil(total / limit),
      },
    };
  }
}
