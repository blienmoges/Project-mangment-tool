import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, Matches, Max, Min } from 'class-validator';
import { AuthUser, CurrentUser } from '../common/decorators';
import { ViewsService } from './views.service';

export class CalendarQuery {
  /** month (default) or week; weeks start on Monday. */
  @IsOptional()
  @IsIn(['month', 'week'])
  view?: 'month' | 'week';

  /** Any day in the period to show; defaults to today. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be a date such as 2027-02-10' })
  @IsISO8601({ strict: true })
  date?: string;

  /** Only one person's tasks: a user id or "me". */
  @IsOptional()
  @Matches(/^(me|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i, { message: 'assigneeId must be a user id or "me"' })
  assigneeId?: string;
}

export class WorkloadQuery {
  /** How many weeks from this one (1 to 12, default 4). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  weeks?: number;
}

@Controller('projects/:projectId')
export class ViewsController {
  constructor(private readonly views: ViewsService) {}

  /** Tasks with start and due dates, dependencies, phases and sprints, for the timeline (Gantt) view. */
  @Get('timeline')
  timeline(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.views.timeline(projectId, user.id);
  }

  /** Every day of the month (whole weeks) or week, with its tasks and sprint / phase dates. */
  @Get('calendar')
  calendar(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string, @Query() q: CalendarQuery) {
    return this.views.calendar(projectId, user.id, q.view, q.date, q.assigneeId);
  }

  /** Hours of open work per person per week, against capacity (PM, Admin). */
  @Get('workload')
  workload(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string, @Query() q: WorkloadQuery) {
    return this.views.workload(projectId, user.id, q.weeks);
  }
}
