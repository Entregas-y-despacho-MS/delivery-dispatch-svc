import { normalizeRecipient } from './idempotency.js';
import { STATUS_NOTICE_DISPATCH_TYPE, STATUS_NOTICE_TABLE, type StatusNoticeEntry } from './status-notice-table.js';

/**
 * The part of a status change this module needs. `dispatch.status_changed` fits it as it is; the incident report
 * does not say what the previous status was, so `previousStatus` can be `null` (unknown).
 */
export interface StatusTransition {
    dispatchId: number;
    status: string;
    previousStatus: string | null;
    /** ISO instant of the transition. */
    updatedAt: string;
}

/** What is read from the dispatch to build the email. `trackingToken` is only ever used to build the link. */
export interface StatusNoticeDispatch {
    dispatchId: number;
    /** `dispatch_types.name`. */
    type: string;
    /** `dispatch_statuses.name` right now. */
    currentStatus: string;
    contactEmail: string | null;
    trackingCode: string | null;
    trackingToken: string | null;
    trackingTokenExpiresAt: Date | null;
}

/** The notification payload. It carries no phone, address, token or other internal data. */
export interface StatusNotice {
    dispatchId: number;
    trackingCode: string | null;
    status: string;
    statusLabel: string;
    message: string;
    subject: string;
    /** ISO instant of the transition (`updatedAt` of the event). */
    occurredAt: string;
    recipient: string;
}

/** The entry of the table when the transition is one the customer is owed an email for; `null` otherwise. */
export function eligibleStatusNotice(event: Pick<StatusTransition, 'status' | 'previousStatus'>): StatusNoticeEntry | null {
    if (event.status === event.previousStatus) return null;
    return Object.hasOwn(STATUS_NOTICE_TABLE, event.status) ? STATUS_NOTICE_TABLE[event.status]! : null;
}

/** Maps an accepted event to the notice, or `null` (not eligible, not a delivery, no recipient, bad date). */
export function buildStatusNotice(event: StatusTransition, dispatch: StatusNoticeDispatch): StatusNotice | null {
    const entry = eligibleStatusNotice(event);
    if (!entry || dispatch.type !== STATUS_NOTICE_DISPATCH_TYPE) return null;
    const recipient = normalizeRecipient(dispatch.contactEmail ?? '');
    if (!recipient) return null;
    const occurred = new Date(event.updatedAt);
    if (Number.isNaN(occurred.getTime())) return null;
    return {
        dispatchId: dispatch.dispatchId,
        trackingCode: dispatch.trackingCode,
        status: event.status,
        statusLabel: entry.statusLabel,
        message: entry.message,
        subject: entry.subject,
        occurredAt: occurred.toISOString(),
        recipient,
    };
}

/** What the recovery task keeps of an email it has to send again. */
export interface StoredNotification {
    dispatchId: number;
    dispatchStatus: string;
    /** ISO instant of the transition. */
    occurredAt: string;
    /** As it was registered. */
    recipient: string;
}

/**
 * The same email as the first attempt built it, from what was stored: the text of the status comes from the table
 * and the code from the dispatch. `null` when the status is no longer in the table (nothing to say about it).
 */
export function rebuildStatusNotice(stored: StoredNotification, dispatch: Pick<StatusNoticeDispatch, 'trackingCode'>): StatusNotice | null {
    if (!Object.hasOwn(STATUS_NOTICE_TABLE, stored.dispatchStatus)) return null;
    const entry = STATUS_NOTICE_TABLE[stored.dispatchStatus]!;
    return {
        dispatchId: stored.dispatchId,
        trackingCode: dispatch.trackingCode,
        status: stored.dispatchStatus,
        statusLabel: entry.statusLabel,
        message: entry.message,
        subject: entry.subject,
        occurredAt: stored.occurredAt,
        recipient: stored.recipient,
    };
}

/** The tracking page URL, or '' when the link would not work (no token, or the token expired). */
export function trackingLink(dispatch: StatusNoticeDispatch, webUrl: string, now: Date): string {
    if (!dispatch.trackingToken) return '';
    if (dispatch.trackingTokenExpiresAt && dispatch.trackingTokenExpiresAt.getTime() <= now.getTime()) return '';
    return `${webUrl}/seguimiento/${dispatch.trackingToken}`;
}

/** Date and time as the customer reads them (America/La_Paz). */
export function formatOccurredAt(occurredAt: string): string {
    return new Intl.DateTimeFormat('es-BO', { dateStyle: 'long', timeStyle: 'short', hourCycle: 'h23', timeZone: 'America/La_Paz' }).format(new Date(occurredAt));
}
