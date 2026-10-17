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

/**
 * A customer email has two moments, each its own event (`metadata.template` says which email):
 * - `notice_reserved`: the email was handed to the mail transport (written under the lock of the batch,
 *   once per order, batch and template — this is what prevents a second send);
 * - `notice_result`: how it ended, `metadata.result` = `sent` | `bounced` | `failed` | `abandoned`.
 * A reservation without a result is "in flight" until its lease runs out (`NOTICE_LEASE_MINUTES`).
 */
export const NOTICE_RESERVED_EVENT = 'notice_reserved';
export const NOTICE_RESULT_EVENT = 'notice_result';

export type NoticeResult = 'sent' | 'bounced' | 'failed' | 'abandoned';

/**
 * How long a reservation without a result counts as "being sent". The SMTP adapter sets no timeouts and
 * nodemailer allows up to 10 minutes of socket silence, so the lease must be longer than that: shorter, and
 * a send that is still alive would be called abandoned. After it, the reservation counts as failed.
 */
export const NOTICE_LEASE_MINUTES = 15;

/** Who the alert of `final_review_end_time` is for (D-46). */
export const FINAL_REVIEW_ALERT_AUDIENCE = ['coordinators', 'supervisor'] as const;
