import { Module } from '@nestjs/common';
import { IncompleteOrderRecoveryTask } from './incomplete-order-recovery.task.js';

@Module({ providers: [IncompleteOrderRecoveryTask] })
export class IncompleteOrderRecoveryModule {}
