/** `customer_notifications.notification_type` of the email sent when a delivery changes status. */
export const STATUS_CHANGE_NOTIFICATION = 'status_change';

/**
 * The source event as it is known: `dispatch.status_changed` has no id of its own, so the transition is
 * identified by the dispatch, the status it reached and the instant it happened.
 */
export function sourceEventKey(dispatchId: number, status: string, occurredAt: string): string {
    return `${dispatchId}:${status}:${occurredAt}`;
}

/** Source event + type of notification: two deliveries of the same event give the same key, so one logical send. */
export function idempotencyKey(notificationType: string, sourceKey: string): string {
    return `${notificationType}:${sourceKey}`;
}

/** The address as it is stored and compared: no surrounding spaces and lower case. */
export function normalizeRecipient(email: string): string {
    return email.trim().toLowerCase();
}
