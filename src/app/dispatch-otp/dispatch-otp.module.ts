import { Module } from '@nestjs/common';
import { SmsModule } from '../../plugins/sms/sms.module.js';
import { RedisDispatchOtpStoreModule } from './adapters/redis-dispatch-otp-store.module.js';
import { DispatchOtpController } from './dispatch-otp.controller.js';
import { DispatchOtpListener } from './dispatch-otp.listener.js';
import { DispatchOtpService } from './dispatch-otp.service.js';

@Module({ imports: [SmsModule.register(), RedisDispatchOtpStoreModule], controllers: [DispatchOtpController], providers: [DispatchOtpService, DispatchOtpListener], exports: [DispatchOtpService] })
export class DispatchOtpModule {}
