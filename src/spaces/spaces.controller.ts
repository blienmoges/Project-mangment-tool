import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators';
import { IncludeArchivedQuery } from '../common/query';
import { AddSpaceMembersDto, CreateSpaceDto, UpdateSpaceDto } from './dto/space.dto';
import { SpacesService } from './spaces.service';

@Controller()
export class SpacesController {
  constructor(private readonly spaces: SpacesService) {}

  /** Spaces the caller can see (archived ones only with ?includeArchived=true). */
  @Get('workspaces/:workspaceId/spaces')
  list(@CurrentUser() user: AuthUser, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Query() q: IncludeArchivedQuery) {
    return this.spaces.list(workspaceId, user.id, q.includeArchived);
  }

  /** Create a space; it starts with the workflow To do, In progress, In review, Done. */
  @Post('workspaces/:workspaceId/spaces')
  create(@CurrentUser() user: AuthUser, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Body() dto: CreateSpaceDto) {
    return this.spaces.create(workspaceId, user.id, dto);
  }

  /** Space details, its workflow and teams, and its projects with progress and overdue counts. */
  @Get('spaces/:spaceId')
  get(@CurrentUser() user: AuthUser, @Param('spaceId', ParseUUIDPipe) spaceId: string, @Query() q: IncludeArchivedQuery) {
    return this.spaces.get(spaceId, user.id, q.includeArchived);
  }

  /** Rename, change visibility, archive ("archived": true) or restore ("archived": false). */
  @Patch('spaces/:spaceId')
  update(@CurrentUser() user: AuthUser, @Param('spaceId', ParseUUIDPipe) spaceId: string, @Body() dto: UpdateSpaceDto) {
    return this.spaces.update(spaceId, user.id, dto);
  }

  /** People in the space (and the team they came through, if any) plus the teams added to it. */
  @Get('spaces/:spaceId/members')
  members(@CurrentUser() user: AuthUser, @Param('spaceId', ParseUUIDPipe) spaceId: string) {
    return this.spaces.members(spaceId, user.id);
  }

  /** Add people (userIds) or whole teams (teamIds). */
  @Post('spaces/:spaceId/members')
  addMembers(@CurrentUser() user: AuthUser, @Param('spaceId', ParseUUIDPipe) spaceId: string, @Body() dto: AddSpaceMembersDto) {
    return this.spaces.addMembers(spaceId, user.id, dto);
  }

  @Delete('spaces/:spaceId/members/:userId')
  @HttpCode(204)
  removeMember(@CurrentUser() user: AuthUser, @Param('spaceId', ParseUUIDPipe) spaceId: string, @Param('userId', ParseUUIDPipe) userId: string) {
    return this.spaces.removeMember(spaceId, user.id, userId);
  }

  /** Remove a team from the space; people who were in it only through the team leave it. */
  @Delete('spaces/:spaceId/teams/:teamId')
  @HttpCode(204)
  removeTeam(@CurrentUser() user: AuthUser, @Param('spaceId', ParseUUIDPipe) spaceId: string, @Param('teamId', ParseUUIDPipe) teamId: string) {
    return this.spaces.removeTeam(spaceId, user.id, teamId);
  }
}
