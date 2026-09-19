import { InternalServerErrorException } from '@nestjs/common';

export class StorageUploadException extends InternalServerErrorException {
    constructor(cause?: string) {
        super({ message: 'File upload failed.', error: 'STORAGE_UPLOAD_FAILED', cause });
    }
}
