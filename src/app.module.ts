import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ActivityModule } from './activity/activity.module';
import { AuthModule } from './auth/auth.module';
import { EventsModule } from './events/events.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProjectsModule } from './projects/projects.module';
import { SkillsModule } from './skills/skills.module';
import { SpacesModule } from './spaces/spaces.module';
import { TasksModule } from './tasks/tasks.module';
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
    EventsModule,
    AuthModule,
    UsersModule,
    WorkspacesModule,
    SkillsModule,
    TeamsModule,
    SpacesModule,
    ProjectsModule,
    TasksModule,
  ],
})
export class AppModule {}

