export class TopicAlreadySubscribedException extends Error {
    constructor(topic: string) {
        super(`Topic "${topic}" already has a handler. Only one handler per topic is allowed.`);
        this.name = TopicAlreadySubscribedException.name;
    }
}
