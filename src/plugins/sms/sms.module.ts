import { DynamicModule, Global, Module } from '@nestjs/common';
import { SimulatedSmsModule } from './simulated/simulated-sms.module.js';

@Global()
@Module({})
export class SmsModule {
    static register(): DynamicModule {
        return { module: SmsModule, imports: [SimulatedSmsModule], exports: [SimulatedSmsModule] };
    }
}
