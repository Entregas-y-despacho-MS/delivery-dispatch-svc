export class MessagingContractsNotFoundException extends Error {
    constructor(directory: string) {
        super(`Message contracts not found in "${directory}". Expected envelope.schema.json and schemas/*.schema.json.`);
        this.name = MessagingContractsNotFoundException.name;
    }
}
