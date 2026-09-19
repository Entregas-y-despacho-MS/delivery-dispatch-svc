import { InternalServerErrorException } from '@nestjs/common';

export class PdfGenerationException extends InternalServerErrorException {
    constructor(cause?: string) {
        super({ message: 'PDF generation failed.', error: 'PDF_GENERATION_FAILED', cause });
    }
}
