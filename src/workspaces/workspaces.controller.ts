import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators';
import { ChangeRoleDto, CreateInvitationsDto, CreateWorkspaceDto, UpdateWorkspaceDto } from './dto/workspace.dto';
import { InvitationsService } from './invitations.service';
import { WorkspacesService } from './workspaces.service';

@Controller('workspaces')
export class WorkspacesController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly invitations: InvitationsService,
  ) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateWorkspaceDto) {
    return this.workspaces.create(user.id, dto);
  }

  @Get(':workspaceId')
  get(@CurrentUser() user: AuthUser, @Param('workspaceId', ParseUUIDPipe) workspaceId: string) {
    return this.workspaces.get(workspaceId, user.id);
  }

  @Patch(':workspaceId')
  update(@CurrentUser() user: AuthUser, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Body() dto: UpdateWorkspaceDto) {
    return this.workspaces.update(workspaceId, user.id, dto);
  }

  @Get(':workspaceId/members')
  members(@CurrentUser() user: AuthUser, @Param('workspaceId', ParseUUIDPipe) workspaceId: string) {
    return this.workspaces.members(workspaceId, user.id);
  }

  @Patch(':workspaceId/members/:userId')
  changeRole(
    @CurrentUser() user: AuthUser,
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: ChangeRoleDto,
  ) {
    return this.workspaces.changeRole(workspaceId, user.id, userId, dto);
  }

  @Delete(':workspaceId/members/:userId')
  @HttpCode(204)
  removeMember(
    @CurrentUser() user: AuthUser,
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.workspaces.removeMember(workspaceId, user.id, userId);
  }

  @Post(':workspaceId/invitations')
  invite(@CurrentUser() user: AuthUser, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Body() dto: CreateInvitationsDto) {
    return this.invitations.create(workspaceId, user.id, dto);
  }

  @Get(':workspaceId/invitations')
  pendingInvitations(@CurrentUser() user: AuthUser, @Param('workspaceId', ParseUUIDPipe) workspaceId: string) {
    return this.invitations.listPending(workspaceId, user.id);
  }
}

