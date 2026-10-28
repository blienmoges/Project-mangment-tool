import { Module } from '@nestjs/common';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';
import { WorkspaceAccessService } from './workspace-access.service';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';

@Module({
  controllers: [WorkspacesController, InvitationsController],
  providers: [WorkspacesService, InvitationsService, WorkspaceAccessService],
  exports: [InvitationsService, WorkspaceAccessService],
})
export class WorkspacesModule {}

