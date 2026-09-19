import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class PuppeteerConfig {
    // Chrome's own sandbox needs a Linux capability (SYS_ADMIN) that Docker denies by default —
    // without it, Chrome fails to launch inside a container. true (default) disables Chrome's
    // sandbox instead (safe here: PdfPort only ever renders HTML this backend builds itself from
    // its own data, never third-party/untrusted content — see decisions.md, 2026-09-19).
    // Set to false only if the container is granted --cap-add=SYS_ADMIN and real sandboxing is wanted.
    readonly noSandbox: boolean;

    constructor(cfg: ConfigService) {
        this.noSandbox = cfg.get<boolean>('PUPPETEER_NO_SANDBOX', true)!;
    }
}
