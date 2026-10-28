import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators';
import { AssignDto, ConcernDto, MoveStatusDto, OptionalStatusDto, RequestChangesDto, SuggestionsQuery } from './dto/task.dto';
import { AssignmentService } from './assignment.service';
import { TaskStatusService } from './task-status.service';

/** Assignment and status actions; each returns the updated task. */
@Controller('tasks/:taskId')
export class TaskActionsController {
  constructor(
    private readonly assignment: AssignmentService,
    private readonly status: TaskStatusService,
  ) {}

  /** Ranked assignees with skill match, matched and missing skills, and workload. Options: ?teamId=, ?includeManager=true, ?limit=. */
  @Get('suggestions')
  suggestions(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string, @Query() q: SuggestionsQuery) {
    return this.assignment.suggestions(taskId, user.id, q);
  }

  /** Confirm an assignee ({ "userId": "..." }) or remove one ({ "userId": null }). */
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

  /** Move to another status (never a closed one: use approve). */
  @Post('status')
  @HttpCode(200)
  move(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string, @Body() dto: MoveStatusDto) {
    return this.status.move(taskId, user.id, dto.statusId);
  }

  /** Move to the first review status (In review). */
  @Post('submit')
  @HttpCode(200)
  submit(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string) {
    return this.status.submit(taskId, user.id);
  }

  /** Approve a task in review; optional statusId picks the closed status (default: the first, e.g. Done). */
  @Post('approve')
  @HttpCode(200)
  approve(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string, @Body() dto: OptionalStatusDto) {
    return this.status.approve(taskId, user.id, dto.statusId);
  }

  /** Send a task in review back to work; optional note (saved as a comment) and statusId. */
  @Post('request-changes')
  @HttpCode(200)
  requestChanges(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string, @Body() dto: RequestChangesDto) {
    return this.status.requestChanges(taskId, user.id, dto.note, dto.statusId);
  }

  /** Reopen a finished task; optional statusId (default: the first active status). */
  @Post('reopen')
  @HttpCode(200)
  reopen(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string, @Body() dto: OptionalStatusDto) {
    return this.status.reopen(taskId, user.id, dto.statusId);
  }
}
