import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class SchedulerConfig {
    /**
     * `false` turns the minute tick off (e2e suites, or an instance that must not run tasks). Manual
     * triggers still work: they do not depend on the clock.
     */
    readonly enabled: boolean;

    constructor(config: ConfigService) {
        this.enabled = config.get<boolean>('SCHEDULER_ENABLED') ?? true;
    }
}
