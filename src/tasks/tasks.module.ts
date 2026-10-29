import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { ProjectsModule } from '../projects/projects.module';
import { TimeModule } from '../time/time.module';
import { AssignmentService } from './assignment.service';
import { TaskAccessService } from './task-access.service';
import { TaskActionsController } from './task-actions.controller';
import { TaskStatusService } from './task-status.service';
import { TaskViewService } from './task-view.service';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

@Module({
  imports: [ProjectsModule, FilesModule, TimeModule],
  controllers: [TasksController, TaskActionsController],
  providers: [TasksService, AssignmentService, TaskStatusService, TaskAccessService, TaskViewService],
  exports: [TaskAccessService, TaskViewService],
})
export class TasksModule {}
