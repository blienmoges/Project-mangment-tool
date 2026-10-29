import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { GithubClient } from './github-client';
import { GithubController } from './github.controller';
import { GithubService } from './github.service';
import { WebhookService } from './webhook.service';

@Module({
  imports: [ProjectsModule, WorkspacesModule],
  controllers: [GithubController],
  providers: [GithubService, WebhookService, GithubClient],
})
export class GithubModule {}
