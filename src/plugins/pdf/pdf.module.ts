import { Global, Module } from '@nestjs/common';
import { PuppeteerModule } from './puppeteer/puppeteer.module.js';

/**
 * Port & Adapter facade for PDF generation.
 * Consumers inject PdfPort. Re-exports PuppeteerModule so PdfPort is available globally.
 * To swap the engine: replace PuppeteerModule with a new adapter module.
 */
@Global()
@Module({
    imports: [PuppeteerModule],
    exports: [PuppeteerModule],
})
export class PdfModule {}
