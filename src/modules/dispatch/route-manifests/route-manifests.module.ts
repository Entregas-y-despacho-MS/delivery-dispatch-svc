import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RouteManifestStop } from './entities/route-manifest-stop.entity.js';
import { RouteManifest } from './entities/route-manifest.entity.js';

/** ST-302.2 (ES-302): tables of the frozen route manifests. The service that writes them arrives with the manifests stage. */
@Module({
    imports: [TypeOrmModule.forFeature([RouteManifest, RouteManifestStop])],
    exports: [TypeOrmModule],
})
export class RouteManifestsModule {}
