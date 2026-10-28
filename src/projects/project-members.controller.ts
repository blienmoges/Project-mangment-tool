import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators';
import { AddProjectMembersDto, ChangeProjectRoleDto } from './dto/project.dto';
import { ProjectMembersService } from './project-members.service';

@Controller('projects/:projectId')
export class ProjectMembersController {
  constructor(private readonly members: ProjectMembersService) {}

  /** People with their project role, plus the teams added to the project. */
  @Get('members')
  list(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.members.list(projectId, user.id);
  }

  /** Add people (userIds) or whole teams (teamIds). */
  @Post('members')
  add(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string, @Body() dto: AddProjectMembersDto) {
    return this.members.add(projectId, user.id, dto);
  }

  /** Change a project role (Admin), for example make someone the new Project Manager. */
  @Patch('members/:userId')
  changeRole(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: ChangeProjectRoleDto,
  ) {
    return this.members.changeRole(projectId, user.id, userId, dto);
  }

  /** Remove a person; their unfinished tasks in the project become unassigned. */
  @Delete('members/:userId')
  @HttpCode(204)
  remove(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string, @Param('userId', ParseUUIDPipe) userId: string) {
    return this.members.remove(projectId, user.id, userId);
  }

  /** Remove a team; people who were in the project only through it leave it. */
  @Delete('teams/:teamId')
  @HttpCode(204)
  removeTeam(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string, @Param('teamId', ParseUUIDPipe) teamId: string) {
    return this.members.removeTeam(projectId, user.id, teamId);
  }
}
