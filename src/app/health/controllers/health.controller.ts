import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import {
    HealthCheck, HealthCheckService,
    TypeOrmHealthIndicator, MemoryHealthIndicator, DiskHealthIndicator,
} from '@nestjs/terminus';
import { Public } from '../../auth/decorators/index.js';

// @Public() — Docker, Kubernetes, and monitoring tools have no JWT token.
@ApiTags('Health')
@Controller('health')
export class HealthController {
    constructor(
        private readonly health: HealthCheckService,
        private readonly db:     TypeOrmHealthIndicator,
        private readonly memory: MemoryHealthIndicator,
        private readonly disk:   DiskHealthIndicator,
    ) {}

    @Get()
    @Public()
    @HealthCheck()
    @ApiOperation({
        summary:     'Application health',
        description: 'Public, no token needed. Checks that the database answers, that the memory heap is under 300 MB and that the disk is under 90% full. Returns 200 when every check passes and 503 when any fails; in both cases `details` lists each check. Meant for Docker, load balancers and uptime monitors.',
    })
    @ApiOkResponse({
        description: 'Every check passed.',
        schema: { example: { status: 'ok', info: { database: { status: 'up' }, memory_heap: { status: 'up' }, disk: { status: 'up' } }, error: {}, details: { database: { status: 'up' }, memory_heap: { status: 'up' }, disk: { status: 'up' } } } },
    })
    @ApiServiceUnavailableResponse({
        description: 'At least one check failed (see `error` for which one).',
        schema: { example: { status: 'error', info: { memory_heap: { status: 'up' }, disk: { status: 'up' } }, error: { database: { status: 'down' } }, details: { database: { status: 'down' }, memory_heap: { status: 'up' }, disk: { status: 'up' } } } },
    })
    check() {
        return this.health.check([
            // Runs SELECT 1 against the TypeORM connection.
            () => this.db.pingCheck('database'),

            // Fails if Node.js heap exceeds 300 MB — adjust to your server specs.
            () => this.memory.checkHeap('memory_heap', 300 * 1024 * 1024),

            // Fails if disk usage exceeds 90%. Remove if the app writes no local files.
            () => this.disk.checkStorage('disk', { path: '/', thresholdPercent: 0.9 }),
        ]);
    }
}
