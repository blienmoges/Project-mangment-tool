import { Global, Module } from '@nestjs/common';
import { WorkloadService } from './workload.service';

@Global()
@Module({ providers: [WorkloadService], exports: [WorkloadService] })
export class WorkloadModule {}
