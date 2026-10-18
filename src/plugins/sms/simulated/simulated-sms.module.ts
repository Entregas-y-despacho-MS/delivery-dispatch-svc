import { Module } from '@nestjs/common';
import { SmsSender } from '../sms.port.js';
import { SimulatedSmsAdapter } from './simulated-sms.adapter.js';

@Module({ providers: [SimulatedSmsAdapter, { provide: SmsSender, useExisting: SimulatedSmsAdapter }], exports: [SmsSender] })
export class SimulatedSmsModule {}
