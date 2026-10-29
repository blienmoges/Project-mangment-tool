import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators';
import { CreateProjectDto, MoveProjectDto, ProjectListQuery, UpdateProjectDto } from './dto/project.dto';
import { ProjectMoveService } from './project-move.service';
import { ProjectsService } from './projects.service';

@Controller()
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly mover: ProjectMoveService,
  ) {}

  /** Projects in a space that the caller can open, with progress. Filters: ?status=, ?includeArchived=true. */
  @Get('spaces/:spaceId/projects')
  list(@CurrentUser() user: AuthUser, @Param('spaceId', ParseUUIDPipe) spaceId: string, @Query() q: ProjectListQuery) {
    return this.projects.list(spaceId, user.id, q);
  }

  /** Create a project; the caller (or managerId) becomes its Project Manager. */
  @Post('spaces/:spaceId/projects')
  create(@CurrentUser() user: AuthUser, @Param('spaceId', ParseUUIDPipe) spaceId: string, @Body() dto: CreateProjectDto) {
    return this.projects.create(spaceId, user.id, dto);
  }

  /** Project details with its workflow (board columns), custom fields, teams, progress and the caller's permissions. */
  @Get('projects/:projectId')
  get(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.projects.get(projectId, user.id);
  }

  @Patch('projects/:projectId')
  update(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string, @Body() dto: UpdateProjectDto) {
    return this.projects.update(projectId, user.id, dto);
  }

  /** Progress, overdue count, open issues, phases and the Needs attention list. */
  @Get('projects/:projectId/dashboard')
  dashboard(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.projects.dashboard(projectId, user.id);
  }

  /** Move the project to another space (Admin). Send "dryRun": true first to see the effect. */
  @Post('projects/:projectId/move')
  @HttpCode(200)
  move(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string, @Body() dto: MoveProjectDto) {
    return this.mover.move(projectId, user.id, dto);
  }
}
