import { ApiProperty } from '@nestjs/swagger';

export class OutboundMessageAlertDto {
  @ApiProperty({ type: 'integer', description: 'Audit alert ID.', example: 42 })
  id: number;

  @ApiProperty({
    enum: ['outbound_message_delayed', 'outbound_message_failed'],
    description: 'Alert emitted by the outbox publisher.',
  })
  action: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Time when the alert was recorded.',
  })
  createdAt: Date;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'ID of the outbox message that raised the alert.',
  })
  messageId: string | null;

  @ApiProperty({
    type: String,
    description: 'Message topic at the time of the alert.',
    example: 'dispatch.shipment.departed',
  })
  messageType: string | null;

  @ApiProperty({
    type: 'integer',
    description: 'Attempt count when the alert was recorded.',
    example: 3,
  })
  attemptsAtAlert: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Last broker error recorded with the alert.',
  })
  lastError: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Current outbox status; null if the message row was removed.',
  })
  currentStatus: string | null;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    description:
      'Current outbox attempt count; null if the message row was removed.',
  })
  currentAttempts: number | null;
}
