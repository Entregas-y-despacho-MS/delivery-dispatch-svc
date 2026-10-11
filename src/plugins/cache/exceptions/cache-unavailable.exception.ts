export class CacheUnavailableException extends Error {
    constructor() {
        super('Cache is unavailable.');
        this.name = CacheUnavailableException.name;
    }
}
