import { Module } from '@nestjs/common';
import { FleetController } from './controllers/fleet.controller.js';
import { FleetService } from './services/fleet.service.js';

// No own table — reads across route_batches/dispatches/vehicles/users (RF-A13 live fleet map).
// Like other app-level read services, this is "system logic", not a domain CRUD module.
@Module({
    controllers: [FleetController],
    providers:   [FleetService],
})
export class FleetModule {}
