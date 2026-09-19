import { LogLevel } from '@nestjs/common';
import { EnvironmentEnum } from '../../shared/enums/index.js';

interface EnvSettings {
    logger:  LogLevel[];
    swagger: boolean;
}

// Fixed per-environment settings — not env vars.
export const environmentSettings: Record<string, EnvSettings> = {
    [EnvironmentEnum.PRODUCTION]: {
        logger:  ['error'],
        swagger: false,
    },
    [EnvironmentEnum.DEVELOPMENT]: {
        logger:  ['error', 'warn', 'log'],
        swagger: true,
    },
    [EnvironmentEnum.TEST]: {
        logger:  ['error'],
        swagger: true,
    },
    [EnvironmentEnum.DEBUG]: {
        logger:  ['error', 'warn', 'log', 'debug', 'verbose'],
        swagger: true,
    },
};

export function getEnvSettings(nodeEnv?: string): EnvSettings {
    return environmentSettings[nodeEnv ?? EnvironmentEnum.DEVELOPMENT];
}
