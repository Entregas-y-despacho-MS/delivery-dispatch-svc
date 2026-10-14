// Contract for email sending — transport-agnostic.
// Consumers inject MailerPort, never the concrete adapter.
// Swapping SMTP to an API provider only requires changing the adapter module.
export interface MailOptions {
    to:           string | string[];
    subject:      string;
    html?:        string;
    text?:        string;
    /** Only available with the SMTP adapter (Handlebars templates). */
    template?:    string;
    context?:     Record<string, any>;
    /** Optional business identifiers; adapters may include them in delivery-result events. */
    metadata?:    Record<string, unknown>;
    attachments?: {
        filename:     string;
        content:      Buffer | string;
        contentType?: string;
    }[];
}

export type MailDeliveryStatus = 'sent' | 'bounced' | 'failed';

export interface MailDeliveryResult {
    status: MailDeliveryStatus;
    error?: string;
}

export const MAIL_DELIVERY_RESULT_EVENT = 'mailer.delivery_result';

// Abstract class (not interface) so NestJS DI can use it as a runtime token.
export abstract class MailerPort {
    abstract send(options: MailOptions): Promise<MailDeliveryResult>;
}
