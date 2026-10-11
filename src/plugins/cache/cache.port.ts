export abstract class CacheService {
    abstract get(key: string): Promise<string | null>;
    abstract set(key: string, value: string): Promise<void>;
    abstract setIfNewer(key: string, version: number, value: string): Promise<void>;
    abstract delete(key: string): Promise<void>;
}
