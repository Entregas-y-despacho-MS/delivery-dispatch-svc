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

export interface AccessUrlResult {
    /** Short-lived URL that grants read access to the file. */
    url:       string;
    expiresAt: Date;
}

// Abstract class (not interface) so NestJS DI can use it as a runtime token.
export abstract class StoragePort {
    abstract upload(options: UploadOptions): Promise<UploadResult>;

    /**
     * Turns the URL returned by `upload()` (what is persisted) into a signed URL that stops working
     * after `ttlSeconds`. The persisted URL is never handed to a client as is.
     */
    abstract getAccessUrl(storedUrl: string, ttlSeconds: number): Promise<AccessUrlResult>;
}
