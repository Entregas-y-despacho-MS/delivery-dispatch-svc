import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020Module from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { MessagingContractsNotFoundException } from '../exceptions/index.js';

// ajv and ajv-formats are CommonJS: under ESM the default import may be the module object itself.
const Ajv2020 = ((Ajv2020Module as { default?: unknown }).default ?? Ajv2020Module) as typeof Ajv2020Module.default;
const addFormats = ((addFormatsModule as { default?: unknown }).default ?? addFormatsModule) as typeof addFormatsModule.default;

const ENVELOPE_FILE = 'envelope.schema.json';
const SCHEMAS_FOLDER = 'schemas';
const SCHEMA_SUFFIX = '.schema.json';

/** Folder with the JSON Schemas of the topics, relative to the working directory of the process. */
export const DEFAULT_CONTRACTS_DIR = 'contracts/messages';

export interface MessageValidationError {
    /** JSON pointer to the invalid value in the message (empty string = the message itself). */
    path: string;
    message: string;
    /** JSON Schema keyword that failed (`required`, `pattern`, ...) or `unknownTopic`. */
    keyword: string;
}

export type MessageValidationResult =
    | { valid: true }
    | { valid: false; errors: MessageValidationError[] };

/**
 * Validates a message against the JSON Schema of its topic (contracts/messages, ST-76.1) before it
 * reaches a handler. The folder is the single source of topics: a topic exists if it has a schema.
 */
export class MessageValidator {
    private constructor(private readonly validators: Map<string, ValidateFunction>) {}

    static fromDirectory(contractsDir: string = DEFAULT_CONTRACTS_DIR): MessageValidator {
        const directory = resolve(contractsDir);
        const envelopePath = resolve(directory, ENVELOPE_FILE);
        const schemasDir = resolve(directory, SCHEMAS_FOLDER);
        if (!existsSync(envelopePath) || !existsSync(schemasDir)) {
            throw new MessagingContractsNotFoundException(directory);
        }

        const ajv = new Ajv2020({ strict: true, allErrors: true });
        addFormats(ajv);
        ajv.addSchema(MessageValidator.readJson(envelopePath));

        const topicSchemas = new Map<string, string>();
        for (const file of readdirSync(schemasDir)) {
            if (!file.endsWith(SCHEMA_SUFFIX)) continue;
            const schema = MessageValidator.readJson(resolve(schemasDir, file));
            ajv.addSchema(schema);
            topicSchemas.set(file.slice(0, -SCHEMA_SUFFIX.length), schema.$id as string);
        }
        if (topicSchemas.size === 0) {
            throw new MessagingContractsNotFoundException(directory);
        }

        const validators = new Map<string, ValidateFunction>();
        for (const [topic, schemaId] of topicSchemas) {
            validators.set(topic, ajv.getSchema(schemaId)!);
        }
        return new MessageValidator(validators);
    }

    /** Topics that have a schema. */
    get topics(): string[] {
        return [...this.validators.keys()].sort();
    }

    hasTopic(topic: string): boolean {
        return this.validators.has(topic);
    }

    validate(topic: string, message: unknown): MessageValidationResult {
        const validator = this.validators.get(topic);
        if (!validator) {
            return {
                valid: false,
                errors: [{ path: '', message: `Unknown topic "${topic}".`, keyword: 'unknownTopic' }],
            };
        }
        if (validator(message)) return { valid: true };

        const errors = (validator.errors ?? []).map((error) => ({
            path: error.instancePath,
            message: error.message ?? 'Invalid value.',
            keyword: error.keyword,
        }));
        return { valid: false, errors };
    }

    private static readJson(path: string): Record<string, unknown> & { $id?: string } {
        return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> & { $id?: string };
    }
}
