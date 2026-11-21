/** Producto o bulto reclamado: exactamente uno de `packageId` / `itemCode`. */
export interface ComplaintAffectedItem {
    packageId?: string;
    itemCode?: string;
    quantity: number;
}

/** `crm.delivery_complaint.opened` — data (contracts/messages/schemas/crm.delivery_complaint.opened.schema.json). */
export interface DeliveryComplaintOpenedData {
    crmCaseId: string;
    caseVersion: number;
    dispatchId?: number;
    trackingCode?: string;
    salesOrderId?: string;
    reasonCode: string;
    openedAt: string;
    affectedItems: ComplaintAffectedItem[];
}

/** `dispatch.delivery_complaint.rejected` — códigos estables del contrato (CRM decide sobre ellos). */
export const COMPLAINT_REJECTION_CODES = [
    'schema_invalid',
    'dispatch_not_found',
    'dispatch_not_delivered',
    'dispatch_reference_mismatch',
    'dispatch_reference_ambiguous',
] as const;

export type ComplaintRejectionCode = (typeof COMPLAINT_REJECTION_CODES)[number];

/** Rechazos que decide el servicio de ingreso tras validar el despacho (todos salvo `schema_invalid`). */
export type DispatchRejectionCode = Exclude<ComplaintRejectionCode, 'schema_invalid'>;

export const COMPLAINT_OPENED_TOPIC = 'crm.delivery_complaint.opened';
export const COMPLAINT_RECEIVED_TOPIC = 'dispatch.delivery_complaint.received';
export const COMPLAINT_REJECTED_TOPIC = 'dispatch.delivery_complaint.rejected';
export const COMPLAINT_SOURCE = 'crm';
