import { Module } from '@nestjs/common';
import { OsrmHttpConfig } from './http.config.js';
import { OsrmHttpAdapter } from './http.adapter.js';
import { OsrmPort } from '../osrm.port.js';

@Module({
    providers: [
        OsrmHttpConfig,
        OsrmHttpAdapter,
        { provide: OsrmPort, useExisting: OsrmHttpAdapter },
    ],
    exports: [OsrmPort],
})
export class OsrmHttpModule {}
