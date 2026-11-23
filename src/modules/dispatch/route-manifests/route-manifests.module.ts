import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RouteManifestStop } from './entities/route-manifest-stop.entity.js';
import { RouteManifest } from './entities/route-manifest.entity.js';
import { RouteManifestService } from './services/route-manifest.service.js';

/**
 * ST-302.2 (ES-302): the frozen route manifests. `RouteManifestService.record` runs inside the transaction of the flow it
 * describes (second approval, route start, a change after the start), so this module depends on nothing but TypeORM.
 */
@Module({
    imports: [TypeOrmModule.forFeature([RouteManifest, RouteManifestStop])],
    providers: [RouteManifestService],
    exports: [TypeOrmModule, RouteManifestService],
})
export class RouteManifestsModule {}
