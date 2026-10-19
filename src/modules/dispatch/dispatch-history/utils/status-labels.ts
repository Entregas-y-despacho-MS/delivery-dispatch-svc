import { DispatchStatusEnum } from '../../../../shared/enums/dispatch-status.enum.js';

/**
 * How the user sees each final status: «Se muestra como» in the status glossary of
 * `docs/interoperabilidad-y-flujos.md` (section 4). The CSV is read by people, so it carries these texts
 * and not the status code; the JSON listing keeps the code and the screen maps it.
 */
export const TERMINAL_STATUS_LABEL_ES: Readonly<Record<string, string>> = {
    [DispatchStatusEnum.DELIVERED]:             'Entregado',
    [DispatchStatusEnum.NOT_DELIVERED]:         'No entregado',
    [DispatchStatusEnum.RETURNED]:              'Devuelto',
    [DispatchStatusEnum.RETURNED_TO_WAREHOUSE]: 'Devuelto a almacén',
    [DispatchStatusEnum.CANCELLED]:             'Cancelado',
};

/** The label of a final status; an unknown one falls back to its code so the row is never blank. */
export function terminalStatusLabel(status: string): string {
    return TERMINAL_STATUS_LABEL_ES[status] ?? status;
}
