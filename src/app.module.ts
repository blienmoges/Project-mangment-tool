import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ActivityModule } from './activity/activity.module';
import { ActivityViewsModule } from './activity/activity-views.module';
import { AuthModule } from './auth/auth.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AutomationsModule } from './automations/automations.module';
import { CommentsModule } from './comments/comments.module';
import { FilesModule } from './files/files.module';
import { GithubModule } from './github/github.module';
import { IssuesModule } from './issues/issues.module';
import { MessagingModule } from './messaging/messaging.module';
import { PrismaModule } from './prisma/prisma.module';
import { RealtimeModule } from './realtime/realtime.module';
import { ProjectsModule } from './projects/projects.module';
import { SkillsModule } from './skills/skills.module';
import { SpacesModule } from './spaces/spaces.module';
import { SprintsModule } from './sprints/sprints.module';
import { TasksModule } from './tasks/tasks.module';
import { TimeModule } from './time/time.module';
import { ViewsModule } from './views/views.module';
import { TeamsModule } from './teams/teams.module';
import { UsersModule } from './users/users.module';
import { WorkloadModule } from './workload/workload.module';
import { WorkspacesModule } from './workspaces/workspaces.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    ActivityModule,
    WorkloadModule,
    RealtimeModule,
    NotificationsModule,
    AuthModule,
    UsersModule,
    WorkspacesModule,
    SkillsModule,
    TeamsModule,
    SpacesModule,
    ProjectsModule,
    TasksModule,
    SprintsModule,
    IssuesModule,
    CommentsModule,
    FilesModule,
    MessagingModule,
    TimeModule,
    ViewsModule,
    AutomationsModule,
    GithubModule,
    ActivityViewsModule,
  ],
})
export class AppModule {}

