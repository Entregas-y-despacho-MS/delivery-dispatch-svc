/** Date and window as the customer reads them in the emails (America/La_Paz). */
export function formatNoticeWindow(start: Date | null, end: Date | null): string {
    if (!start || !end) return '';
    const formatter = new Intl.DateTimeFormat('es-BO', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'America/La_Paz' });
    return `${formatter.format(start)} – ${formatter.format(end)}`;
}

export function formatNoticeDate(date: Date | null): string {
    if (!date) return '';
    return new Intl.DateTimeFormat('es-BO', { dateStyle: 'long', timeZone: 'America/La_Paz' }).format(date);
}
