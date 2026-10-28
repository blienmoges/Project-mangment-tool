import { Module } from '@nestjs/common';
import { SpacesModule } from '../spaces/spaces.module';
import { TeamsModule } from '../teams/teams.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { PhasesController } from './phases.controller';
import { PhasesService } from './phases.service';
import { ProjectAccessService } from './project-access.service';
import { ProjectMembersController } from './project-members.controller';
import { ProjectMembersService } from './project-members.service';
import { ProjectMoveService } from './project-move.service';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

@Module({
  imports: [WorkspacesModule, SpacesModule, TeamsModule],
  controllers: [ProjectsController, ProjectMembersController, PhasesController],
  providers: [ProjectsService, ProjectMembersService, PhasesService, ProjectMoveService, ProjectAccessService],
  exports: [ProjectAccessService],
})
export class ProjectsModule {}
