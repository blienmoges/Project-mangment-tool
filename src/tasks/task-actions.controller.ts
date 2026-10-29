import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators';
import { AssignmentService } from './assignment.service';
import { ApproveDto, AssignDto, ConcernDto, MoveStatusDto, ReopenDto, RequestChangesDto, SuggestionsQuery } from './dto/task.dto';
import { TaskStatusService } from './task-status.service';

@Controller('tasks/:taskId')
export class TaskActionsController {
  constructor(
    private readonly assignment: AssignmentService,
    private readonly status: TaskStatusService,
  ) {}

  /** Ranked assignees: skill match, matched / partial / missing skills, workload. Optional ?teamId=, ?includeManager=true, ?limit=. */
  @Get('suggestions')
  suggestions(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string, @Query() q: SuggestionsQuery) {
    return this.assignment.suggestions(taskId, user.id, q);
  }

  /** Confirm an assignee ({ "userId": "..." }), or unassign with { "userId": null }. */
  @Post('assign')
  @HttpCode(200)
  assign(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string, @Body() dto: AssignDto) {
    return this.assignment.assign(taskId, user.id, dto);
  }

  @Post('accept')
  @HttpCode(200)
  accept(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string) {
    return this.assignment.accept(taskId, user.id);
  }

  @Post('concern')
  @HttpCode(200)
  concern(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string, @Body() dto: ConcernDto) {
    return this.assignment.concern(taskId, user.id, dto);
  }

  /** Move to another status (never a closed one: that needs approval). */
  @Post('status')
  @HttpCode(200)
  move(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string, @Body() dto: MoveStatusDto) {
    return this.status.move(taskId, user.id, dto);
  }

  /** Submit for review (moves to the first Review status). */
  @Post('submit')
  @HttpCode(200)
  submit(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string) {
    return this.status.submit(taskId, user.id);
  }

  /** Approve and close (PM, Admin). Optional statusId names the closed status. */
  @Post('approve')
  @HttpCode(200)
  approve(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string, @Body() dto: ApproveDto) {
    return this.status.approve(taskId, user.id, dto);
  }

  /** Send it back from review with a note (PM, Admin). */
  @Post('request-changes')
  @HttpCode(200)
  requestChanges(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string, @Body() dto: RequestChangesDto) {
    return this.status.requestChanges(taskId, user.id, dto);
  }

  /** Reopen a finished task (PM, Admin). */
  @Post('reopen')
  @HttpCode(200)
  reopen(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string, @Body() dto: ReopenDto) {
    return this.status.reopen(taskId, user.id, dto);
  }
}
