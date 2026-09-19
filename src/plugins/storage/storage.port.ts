// Contract for file storage — provider-agnostic.
// Consumers inject StoragePort, never the concrete adapter.
// Swapping local disk to Cloudinary only requires changing STORAGE_PROVIDER.
export interface UploadOptions {
    buffer:    Buffer;
    filename:  string;
    mimeType?: string;
}

export interface UploadResult {
    url: string;
}

// Abstract class (not interface) so NestJS DI can use it as a runtime token.
export abstract class StoragePort {
    abstract upload(options: UploadOptions): Promise<UploadResult>;
}
