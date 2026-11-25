export interface PdfOptions {
    format?:          'A4' | 'Letter' | 'Legal';
    printBackground?: boolean;
    /** Wide tables: the page is turned sideways (default false). */
    landscape?:       boolean;
    margin?:          { top?: string; bottom?: string; left?: string; right?: string };
}

// Contract for PDF generation — independent of the underlying engine.
// Consumers inject PdfPort, never the concrete adapter.
export abstract class PdfPort {
    abstract generate(html: string, options?: PdfOptions): Promise<Buffer>;
}
