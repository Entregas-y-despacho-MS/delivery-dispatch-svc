import { Controller, Get, NotFoundException, Param, Query, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { access } from 'node:fs/promises';
import { Public } from '../../../app/auth/decorators/index.js';
import { LocalStorageAdapter } from './local.adapter.js';

/**
 * Serves stored files. Public on purpose: the signature + expiry in the query string ARE the
 * authorization (issued by `getAccessUrl`, only to coordinators/supervisors through the dispatch
 * 360 view). Anything unsigned, tampered or expired answers 404, so a name cannot be probed.
 */
@ApiExcludeController()
@Controller('uploads')
export class LocalStorageController {
    constructor(private readonly adapter: LocalStorageAdapter) {}

    @Public()
    @Get(':name')
    async serve(
        @Param('name') name: string,
        @Query('exp') exp: string,
        @Query('sig') sig: string,
        @Res() res: Response,
    ): Promise<void> {
        const path = this.adapter.resolvePath(name);
        if (!path || typeof sig !== 'string' || !this.adapter.verifyAccess(name, Number(exp), sig)) {
            throw new NotFoundException();
        }
        try {
            await access(path);
        } catch {
            throw new NotFoundException();
        }
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.sendFile(path);
    }
}
