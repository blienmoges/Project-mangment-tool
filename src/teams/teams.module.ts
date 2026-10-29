import { Module } from '@nestjs/common';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { TeamAccessService } from './team-access.service';
import { TeamsController } from './teams.controller';
import { TeamsService } from './teams.service';

@Module({
  imports: [WorkspacesModule],
  controllers: [TeamsController],
  providers: [TeamsService, TeamAccessService],
  exports: [TeamAccessService],
})
export class TeamsModule {}
