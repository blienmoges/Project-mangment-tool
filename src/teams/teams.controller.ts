import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators';
import { AddTeamMembersDto, CreateTeamDto, DeleteTeamQuery, UpdateTeamDto } from './dto/team.dto';
import { TeamsService } from './teams.service';

@Controller()
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  /** Teams with their members and workload. */
  @Get('workspaces/:workspaceId/teams')
  list(@CurrentUser() user: AuthUser, @Param('workspaceId', ParseUUIDPipe) workspaceId: string) {
    return this.teams.list(workspaceId, user.id);
  }

  @Post('workspaces/:workspaceId/teams')
  create(@CurrentUser() user: AuthUser, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Body() dto: CreateTeamDto) {
    return this.teams.create(workspaceId, user.id, dto);
  }

  /** One team with members, workload, skills coverage, and the spaces and projects it is added to. */
  @Get('teams/:teamId')
  get(@CurrentUser() user: AuthUser, @Param('teamId', ParseUUIDPipe) teamId: string) {
    return this.teams.get(teamId, user.id);
  }

  @Patch('teams/:teamId')
  update(@CurrentUser() user: AuthUser, @Param('teamId', ParseUUIDPipe) teamId: string, @Body() dto: UpdateTeamDto) {
    return this.teams.update(teamId, user.id, dto);
  }

  @Delete('teams/:teamId')
  @HttpCode(204)
  remove(@CurrentUser() user: AuthUser, @Param('teamId', ParseUUIDPipe) teamId: string, @Query() query: DeleteTeamQuery) {
    return this.teams.remove(teamId, user.id, query.keepAccess ?? false);
  }

  /** Add people; they also join the team's spaces and projects. */
  @Post('teams/:teamId/members')
  addMembers(@CurrentUser() user: AuthUser, @Param('teamId', ParseUUIDPipe) teamId: string, @Body() dto: AddTeamMembersDto) {
    return this.teams.addMembers(teamId, user.id, dto);
  }

  @Delete('teams/:teamId/members/:userId')
  @HttpCode(204)
  removeMember(@CurrentUser() user: AuthUser, @Param('teamId', ParseUUIDPipe) teamId: string, @Param('userId', ParseUUIDPipe) userId: string) {
    return this.teams.removeMember(teamId, user.id, userId);
  }
}
