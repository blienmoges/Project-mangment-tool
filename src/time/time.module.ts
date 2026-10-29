import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { TimeController } from './time.controller';
import { TimeService } from './time.service';

@Module({ imports: [ProjectsModule], controllers: [TimeController], providers: [TimeService], exports: [TimeService] })
export class TimeModule {}
