import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators';
import { CompleteSprintDto, CreateSprintDto, UpdateSprintDto } from './dto/sprint.dto';
import { SprintsService } from './sprints.service';

@Controller()
export class SprintsController {
  constructor(private readonly sprints: SprintsService) {}

  /** All sprints of the project, newest first, with planned and completed points. */
  @Get('projects/:projectId/sprints')
  list(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.sprints.list(projectId, user.id);
  }

  /** Plan a sprint: name, goal, startDate, endDate (two weeks by default). */
  @Post('projects/:projectId/sprints')
  create(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string, @Body() dto: CreateSprintDto) {
    return this.sprints.create(projectId, user.id, dto);
  }

  /** Unfinished tasks in no sprint, highest priority first, with total points and hours. */
  @Get('projects/:projectId/backlog')
  backlog(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.sprints.backlog(projectId, user.id);
  }

  /** Points completed in the last six sprints, and their average. */
  @Get('projects/:projectId/velocity')
  velocity(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.sprints.velocity(projectId, user.id);
  }

  @Get('sprints/:sprintId')
  get(@CurrentUser() user: AuthUser, @Param('sprintId', ParseUUIDPipe) sprintId: string) {
    return this.sprints.get(sprintId, user.id);
  }

  @Patch('sprints/:sprintId')
  update(@CurrentUser() user: AuthUser, @Param('sprintId', ParseUUIDPipe) sprintId: string, @Body() dto: UpdateSprintDto) {
    return this.sprints.update(sprintId, user.id, dto);
  }

  /** Delete a sprint that has not started; its tasks go back to the backlog. */
  @Delete('sprints/:sprintId')
  @HttpCode(204)
  remove(@CurrentUser() user: AuthUser, @Param('sprintId', ParseUUIDPipe) sprintId: string) {
    return this.sprints.remove(sprintId, user.id);
  }

  /** Start the sprint; refused with SPRINT_ALREADY_ACTIVE if another is active. */
  @Post('sprints/:sprintId/start')
  @HttpCode(200)
  start(@CurrentUser() user: AuthUser, @Param('sprintId', ParseUUIDPipe) sprintId: string) {
    return this.sprints.start(sprintId, user.id);
  }

  /** Complete it: { "moveUnfinishedTo": "backlog" } or a planned sprint's id. */
  @Post('sprints/:sprintId/complete')
  @HttpCode(200)
  complete(@CurrentUser() user: AuthUser, @Param('sprintId', ParseUUIDPipe) sprintId: string, @Body() dto: CompleteSprintDto) {
    return this.sprints.complete(sprintId, user.id, dto);
  }

  /** Remaining story points per day, plus the ideal line. */
  @Get('sprints/:sprintId/burndown')
  burndown(@CurrentUser() user: AuthUser, @Param('sprintId', ParseUUIDPipe) sprintId: string) {
    return this.sprints.burndown(sprintId, user.id);
  }

  /** Planned work compared with what the team can do in the sprint. */
  @Get('sprints/:sprintId/capacity')
  capacity(@CurrentUser() user: AuthUser, @Param('sprintId', ParseUUIDPipe) sprintId: string) {
    return this.sprints.capacity(sprintId, user.id);
  }
}
