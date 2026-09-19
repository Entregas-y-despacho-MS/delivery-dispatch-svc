import { Injectable } from '@nestjs/common';
import puppeteer, { Browser } from 'puppeteer';
import { PdfPort, PdfOptions } from '../pdf.port.js';
import { PdfGenerationException } from '../exceptions/index.js';
import { PuppeteerConfig } from './puppeteer.config.js';

@Injectable()
export class PuppeteerAdapter extends PdfPort {
    private browser: Browser;

    constructor(private readonly config: PuppeteerConfig) {
        super();
    }

    async onModuleInit(): Promise<void> {
        // --disable-dev-shm-usage and --disable-gpu apply regardless of sandbox mode — Docker's
        // default /dev/shm is too small for Chrome, and no GPU is available in a headless server.
        const args = ['--disable-dev-shm-usage', '--disable-gpu'];
        if (this.config.noSandbox) args.push('--no-sandbox', '--disable-setuid-sandbox');

        this.browser = await puppeteer.launch({ headless: true, args });
    }

    async onModuleDestroy(): Promise<void> {
        await this.browser?.close();
    }

    async generate(html: string, options: PdfOptions = {}): Promise<Buffer> {
        const page = await this.browser.newPage();
        try {
            await page.setContent(html, { waitUntil: 'domcontentloaded' });
            const pdf = await page.pdf({
                format:          options.format          ?? 'Letter',
                printBackground: options.printBackground ?? true,
                margin:          options.margin,
            });
            return Buffer.from(pdf);
        } catch (err) {
            throw new PdfGenerationException(err.message);
        } finally {
            await page.close();
        }
    }
}
