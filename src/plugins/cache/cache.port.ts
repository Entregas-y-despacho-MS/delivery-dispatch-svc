export abstract class CacheService {
    abstract get(key: string): Promise<string | null>;
    abstract set(key: string, value: string): Promise<void>;
    abstract setIfNewer(key: string, version: number, value: string): Promise<void>;
    abstract delete(key: string): Promise<void>;

    /** Stores a value that disappears on its own after `ttlSeconds` (codes, proofs: the expiry is the cache's job). */
    abstract setWithTtl(key: string, value: string, ttlSeconds: number): Promise<void>;

    /**
     * Adds 1 to a counter and returns the new value, atomically: two callers never get the same number.
     * The counter lives `ttlSeconds` from its FIRST increment (a fixed window); later increments do not extend it.
     */
    abstract increment(key: string, ttlSeconds: number): Promise<number>;

    /** Reads and removes a value in one step: of two concurrent callers only one receives it. */
    abstract take(key: string): Promise<string | null>;
}
