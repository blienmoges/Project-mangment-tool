import { Module } from '@nestjs/common';
import { TeamsModule } from '../teams/teams.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { CustomFieldsController } from './custom-fields.controller';
import { CustomFieldsService } from './custom-fields.service';
import { SpaceAccessService } from './space-access.service';
import { SpacesController } from './spaces.controller';
import { SpacesService } from './spaces.service';
import { StatusesController } from './statuses.controller';
import { StatusesService } from './statuses.service';

@Module({
  imports: [WorkspacesModule, TeamsModule],
  controllers: [SpacesController, StatusesController, CustomFieldsController],
  providers: [SpacesService, StatusesService, CustomFieldsService, SpaceAccessService],
  exports: [SpaceAccessService],
})
export class SpacesModule {}
