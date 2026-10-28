import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { AssignmentService } from './assignment.service';
import { TaskAccessService } from './task-access.service';
import { TaskActionsController } from './task-actions.controller';
import { TaskStatusService } from './task-status.service';
import { TaskViewService } from './task-view.service';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

@Module({
  imports: [ProjectsModule],
  controllers: [TasksController, TaskActionsController],
  providers: [TasksService, AssignmentService, TaskStatusService, TaskAccessService, TaskViewService],
  exports: [TaskAccessService, TaskViewService],
})
export class TasksModule {}
