/**
 * `route_batch_events.event_type` / `dispatch_events.event_type` written by the 2nd-approval timeline
 * (ST-51.4). They double as the record that a step already happened, so every task can be re-run.
 * Events of an order carry `metadata.routeBatchId`: "already sent" always means *for this batch*, so an
 * order that later enters another batch (a reschedule, D-49) is owed its notices again.
 */
export const FINAL_REVIEW_ALERTED_EVENT = 'final_review_alerted';
export const FINAL_REVIEW_ESCALATED_EVENT = 'final_review_escalated';
export const COORDINATOR_TASK_REQUIRED_EVENT = 'coordinator_task_required';
export const CONTACT_MANAGEMENT_REQUIRED_EVENT = 'contact_management_required';
export const ROUTE_REMINDER_SENT_EVENT = 'route_reminder_sent';
export const RISK_NOTICE_SENT_EVENT = 'risk_notice_sent';
/** The risk notice was reserved but the mail transport bounced or failed: the customer was NOT warned. */
export const RISK_NOTICE_FAILED_EVENT = 'risk_notice_failed';
export const DELIVERY_MAINTAINED_SENT_EVENT = 'delivery_maintained_sent';

/** Who the alert of `final_review_end_time` is for (D-46). */
export const FINAL_REVIEW_ALERT_AUDIENCE = ['coordinators', 'supervisor'] as const;
