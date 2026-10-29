import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators';
import { ActivityQuery, ActivityQueryService } from './activity-query.service';

@Controller()
export class ActivityController {
  constructor(private readonly activity: ActivityQueryService) {}

  /** Every change in the workspace (Admin); filters: actorId, entityType, from, to. */
  @Get('workspaces/:workspaceId/activity')
  workspace(@CurrentUser() user: AuthUser, @Param('workspaceId', ParseUUIDPipe) id: string, @Query() q: ActivityQuery) {
    return this.activity.workspace(id, user.id, q);
  }

  /** Changes in one project (PM, Admin). */
  @Get('projects/:projectId/activity')
  project(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) id: string, @Query() q: ActivityQuery) {
    return this.activity.project(id, user.id, q);
  }

  /** History of one task (Members, Admin). */
  @Get('tasks/:taskId/activity')
  task(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) id: string, @Query() q: ActivityQuery) {
    return this.activity.task(id, user.id, q);
  }
}
