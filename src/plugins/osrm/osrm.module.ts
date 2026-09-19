import { Global, Module } from '@nestjs/common';
import { OsrmHttpModule } from './http/http.module.js';

/**
 * Port & Adapter facade for the routing engine (self-hosted OSRM — see ../../osrm-svc at the
 * repo root). Consumers inject OsrmPort. Re-exports OsrmHttpModule so OsrmPort is global.
 */
@Global()
@Module({
    imports: [OsrmHttpModule],
    exports: [OsrmHttpModule],
})
export class OsrmModule {}
