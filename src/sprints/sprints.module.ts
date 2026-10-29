import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { TasksModule } from '../tasks/tasks.module';
import { SprintsController } from './sprints.controller';
import { SprintsService } from './sprints.service';

@Module({ imports: [ProjectsModule, TasksModule], controllers: [SprintsController], providers: [SprintsService] })
export class SprintsModule {}
