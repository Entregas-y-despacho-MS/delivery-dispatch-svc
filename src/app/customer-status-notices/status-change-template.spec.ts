import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Handlebars from 'handlebars';
import { describe, expect, it } from 'vitest';
import { STATUS_NOTICE_TEMPLATE } from './domain/status-notice-table.js';

// The real `.hbs` compiled with Handlebars (the engine of the SMTP adapter), not a mock of the mailer.
const render = Handlebars.compile(readFileSync(join(process.cwd(), 'src/plugins/mailer/templates', `${STATUS_NOTICE_TEMPLATE}.hbs`), 'utf8'));
const context = { statusLabel: 'Entregado', message: 'Tu pedido fue entregado.', occurredAt: '19 de noviembre de 2026, 10:30', trackingCode: 'DSP-2026-00007', trackingUrl: '' };

describe('status-change.hbs', () => {
    it('shows the status, the message, the time and the code', () => {
        const html = render(context);
        expect(html).toContain('<h1>Entregado</h1>');
        expect(html).toContain('Tu pedido fue entregado.');
        expect(html).toContain('19 de noviembre de 2026, 10:30');
        expect(html).toContain('DSP-2026-00007');
    });

    it('links the tracking page only when there is a URL, and otherwise points to Despacho', () => {
        const withLink = render({ ...context, trackingUrl: 'http://web.test/seguimiento/tok' });
        expect(withLink).toContain('href="http://web.test/seguimiento/tok"');
        expect(withLink).not.toContain('comunícate con Despacho');

        const without = render(context);
        expect(without).not.toContain('href=');
        expect(without).toContain('comunícate con Despacho');
    });

    it('escapes what comes from the context', () => {
        expect(render({ ...context, message: '<script>x</script>' })).not.toContain('<script>');
    });
});
