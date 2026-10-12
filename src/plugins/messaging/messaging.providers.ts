import type { Provider } from '@nestjs/common';
import { MessageValidator } from './envelope/message-validator.js';

/** Loads the JSON Schemas of the topics once; MESSAGING_CONTRACTS_DIR overrides the default folder. */
export const messageValidatorProvider: Provider = {
    provide: MessageValidator,
    useFactory: (): MessageValidator =>
        MessageValidator.fromDirectory(process.env.MESSAGING_CONTRACTS_DIR || undefined),
};
