import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators';
import { AssignIssueDto, CreateIssueDto, IssueListQuery, IssueStatusDto, UpdateIssueDto } from './dto/issue.dto';
import { IssuesService } from './issues.service';

@Controller()
export class IssuesController {
  constructor(private readonly issues: IssuesService) {}

  /** List issues, most severe first. Filters: status (or "unresolved"), type, severity, taskId, assigneeId, q. */
  @Get('projects/:projectId/issues')
  list(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string, @Query() q: IssueListQuery) {
    return this.issues.list(projectId, user.id, q);
  }

  /** Report an issue. The PM and the task's assignee are notified; Critical alerts the whole team by SMS too. */
  @Post('projects/:projectId/issues')
  create(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string, @Body() dto: CreateIssueDto) {
    return this.issues.create(projectId, user.id, dto);
  }

  @Get('issues/:issueId')
  get(@CurrentUser() user: AuthUser, @Param('issueId', ParseUUIDPipe) issueId: string) {
    return this.issues.get(issueId, user.id);
  }

  @Patch('issues/:issueId')
  update(@CurrentUser() user: AuthUser, @Param('issueId', ParseUUIDPipe) issueId: string, @Body() dto: UpdateIssueDto) {
    return this.issues.update(issueId, user.id, dto);
  }

  /** Choose who fixes it: { "userId": "..." } (or null). */
  @Post('issues/:issueId/assign')
  @HttpCode(200)
  assign(@CurrentUser() user: AuthUser, @Param('issueId', ParseUUIDPipe) issueId: string, @Body() dto: AssignIssueDto) {
    return this.issues.assign(issueId, user.id, dto);
  }

  /** Move to in_progress, resolved, closed or back to open; resolving notifies the reporter. */
  @Post('issues/:issueId/status')
  @HttpCode(200)
  status(@CurrentUser() user: AuthUser, @Param('issueId', ParseUUIDPipe) issueId: string, @Body() dto: IssueStatusDto) {
    return this.issues.setStatus(issueId, user.id, dto);
  }
}
