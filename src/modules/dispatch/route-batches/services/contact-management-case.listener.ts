import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { MAIL_DELIVERY_RESULT_EVENT, MailDeliveryResult, MailOptions } from '../../../../plugins/mailer/mailer.port.js';

interface MailDeliveryEvent extends MailDeliveryResult {
    options: MailOptions;
}

@Injectable()
export class ContactManagementCaseListener {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    @OnEvent(MAIL_DELIVERY_RESULT_EVENT, { async: true })
    async openCaseForBouncedPromise(event: MailDeliveryEvent): Promise<void> {
        if (event.status !== 'bounced') return;
        const { dispatchId, routeBatchId } = event.options.metadata ?? {};
        if (!Number.isInteger(dispatchId) || !Number.isInteger(routeBatchId)) return;

        const metadata = JSON.stringify({
            category: 'customer_contact',
            recipient: event.options.to,
            template: event.options.template ?? null,
            deliveryResult: event.status,
        });
        await this.dataSource.transaction(async (manager) => {
            await manager.query(
                `INSERT INTO dispatch_events (dispatch_id, event_type, actor_type, reason, metadata)
                 VALUES ($1, 'promise_email_bounced', 'system', 'Customer contact is required after email bounce', $2::jsonb)`,
                [dispatchId, metadata],
            );
            await manager.query(
                `INSERT INTO route_batch_events (route_batch_id, dispatch_id, event_type, actor_type, reason, metadata)
                 VALUES ($1, $2, 'contact_management_required', 'system', 'Promise email bounced; coordinator must contact the customer', $3::jsonb)`,
                [routeBatchId, dispatchId, metadata],
            );
        });
    }
}
