import { Module } from '@nestjs/common';
import { PuppeteerConfig } from './puppeteer.config.js';
import { PuppeteerAdapter } from './puppeteer.adapter.js';
import { PdfPort } from '../pdf.port.js';

@Module({
    providers: [
        PuppeteerConfig,
        PuppeteerAdapter,
        { provide: PdfPort, useExisting: PuppeteerAdapter },
    ],
    exports: [PdfPort],
})
export class PuppeteerModule {}
