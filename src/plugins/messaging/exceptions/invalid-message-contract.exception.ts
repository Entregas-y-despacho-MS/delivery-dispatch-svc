export class InvalidMessageContractException extends Error {
    constructor(file: string, reason: string) {
        super(`Message contract "${file}" is not valid: ${reason}.`);
        this.name = InvalidMessageContractException.name;
    }
}
