import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ActivityController } from './activity.controller';
import { ActivityQueryService } from './activity-query.service';

/** The read side of the activity log (the writer, ActivityService, is in ActivityModule and used everywhere). */
@Module({ imports: [ProjectsModule, WorkspacesModule], controllers: [ActivityController], providers: [ActivityQueryService] })
export class ActivityViewsModule {}
