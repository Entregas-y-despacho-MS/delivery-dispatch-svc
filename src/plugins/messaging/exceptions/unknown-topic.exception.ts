export class UnknownTopicException extends Error {
    constructor(topic: string) {
        super(`Topic "${topic}" is not in the message catalog (contracts/messages/schemas).`);
        this.name = UnknownTopicException.name;
    }
}
