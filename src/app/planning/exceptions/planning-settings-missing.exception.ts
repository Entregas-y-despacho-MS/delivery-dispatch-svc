import { UnprocessableEntityException } from '@nestjs/common';

/**
 * The generator did not run because a mandatory setting is empty or invalid (for example a fresh
 * database where stop_service_minutes and planning_margin_pct are still `''`, docs §6.4 D).
 * Nothing was written.
 */
export class PlanningSettingsMissingException extends UnprocessableEntityException {
    constructor(missingKeys: string[], invalidKeys: string[] = [], configurationProblem: string | null = null) {
        const parts: string[] = [];
        if (missingKeys.length) parts.push(`missing: ${missingKeys.join(', ')}`);
        if (invalidKeys.length) parts.push(`invalid: ${invalidKeys.join(', ')}`);
        if (configurationProblem) parts.push(configurationProblem);
        super({
            message: `The plan generator cannot run until the settings are fixed (${parts.join('; ')}). Set them with PUT /settings/:key.`,
            error:   'PLANNING_SETTINGS_MISSING',
            details: { missingKeys, invalidKeys },
        });
    }
}
