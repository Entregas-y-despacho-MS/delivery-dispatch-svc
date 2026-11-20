/** What the customer is told for a status. Only these statuses produce an email (ST-39.1, RF-U16). */
export interface StatusNoticeEntry {
    subject: string;
    /** The status as the customer reads it. */
    statusLabel: string;
    message: string;
}

/** Only `delivery` dispatches have an end customer; pickups and supplier movements never get this email. */
export const STATUS_NOTICE_DISPATCH_TYPE = 'delivery';

/** Template of the email (`plugins/mailer/templates/status-change.hbs`); one for every status below. */
export const STATUS_NOTICE_TEMPLATE = 'status-change';

/**
 * Version of that template, recorded with every send (ST-39.2). Raise it whenever the wording or the data the
 * template shows changes, so a delivery can be traced to what the customer actually read.
 */
export const STATUS_NOTICE_TEMPLATE_VERSION = 1;

/**
 * Approved status → email table. `scheduled` is deliberately absent (the promise email already covers it)
 * and so is every internal status (`pending`, `in_planning`, `assigned`, `address_review`, pickup statuses).
 * The incident / reschedule reason is internal and is never part of the email.
 */
export const STATUS_NOTICE_TABLE: Readonly<Record<string, StatusNoticeEntry>> = {
    out_for_delivery: {
        subject: 'Tu pedido salió a ruta',
        statusLabel: 'En ruta',
        message: 'Tu pedido salió del almacén y está en ruta de entrega.',
    },
    in_transit: {
        subject: 'Tu repartidor va hacia tu dirección',
        statusLabel: 'Repartidor en camino',
        message: 'El repartidor se dirige a tu dirección. Prepárate para recibir tu pedido.',
    },
    delivered: {
        subject: 'Tu pedido fue entregado',
        statusLabel: 'Entregado',
        message: 'Tu pedido fue entregado. Gracias por tu preferencia.',
    },
    incident: {
        subject: 'Tuvimos un inconveniente con tu entrega',
        statusLabel: 'Inconveniente en la entrega',
        message: 'Tuvimos un inconveniente con tu entrega. Estamos gestionándolo y te avisaremos de cualquier novedad.',
    },
    not_delivered: {
        subject: 'No pudimos entregar tu pedido',
        statusLabel: 'No entregado',
        message: 'No pudimos entregar tu pedido. Despacho se pondrá en contacto contigo para coordinar una nueva entrega.',
    },
    rescheduled: {
        subject: 'Tu entrega fue reprogramada',
        statusLabel: 'Reprogramado',
        message: 'Tu entrega fue reprogramada. Te confirmaremos la nueva fecha y franja.',
    },
    cancelled: {
        subject: 'Tu pedido fue cancelado',
        statusLabel: 'Cancelado',
        message: 'Tu pedido fue cancelado. Si no lo esperabas, comunícate con Despacho.',
    },
    returned: {
        subject: 'Tu pedido volvió a almacén',
        statusLabel: 'Devuelto a almacén',
        message: 'Tu pedido volvió a almacén. Despacho se pondrá en contacto contigo.',
    },
};
