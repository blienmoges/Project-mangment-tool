import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, RawBodyRequest, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsUUID } from 'class-validator';
import { Request, Response } from 'express';
import { Errors } from '../common/app-exception';
import { AuthUser, CurrentUser, Public } from '../common/decorators';
import { verifyWebhookSignature } from './github-signing';
import { GithubService } from './github.service';
import { WebhookService } from './webhook.service';

export class LinkRepositoryDto {
  /** The id from GET /workspaces/:id/github/repositories. */
  @IsUUID()
  repositoryId: string;
}

@Controller()
export class GithubController {
  constructor(
    private readonly github: GithubService,
    private readonly webhooks: WebhookService,
    private readonly config: ConfigService,
  ) {}

  /** Whether GitHub is set up on the server, and the connected GitHub accounts. */
  @Get('workspaces/:workspaceId/github')
  status(@CurrentUser() user: AuthUser, @Param('workspaceId', ParseUUIDPipe) workspaceId: string) {
    return this.github.status(workspaceId, user.id);
  }

  /** The GitHub link that starts installing the app (Admin); valid 30 minutes. */
  @Get('workspaces/:workspaceId/github/install')
  install(@CurrentUser() user: AuthUser, @Param('workspaceId', ParseUUIDPipe) workspaceId: string) {
    return this.github.installLink(workspaceId, user.id);
  }

  /** GitHub sends the browser here after the installation; it is then sent on to the web app's settings page. */
  @Public()
  @Get('github/callback')
  async callback(@Query() q: Record<string, string>, @Res() res: Response) {
    res.redirect(302, await this.github.callback(q));
  }

  @Get('workspaces/:workspaceId/github/repositories')
  repositories(@CurrentUser() user: AuthUser, @Param('workspaceId', ParseUUIDPipe) workspaceId: string) {
    return this.github.repositories(workspaceId, user.id);
  }

  @Get('projects/:projectId/repositories')
  projectRepositories(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.github.projectRepositories(projectId, user.id);
  }

  /** Link a repository to the project (Admin). */
  @Post('projects/:projectId/repositories')
  link(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string, @Body() dto: LinkRepositoryDto) {
    return this.github.link(projectId, user.id, dto.repositoryId);
  }

  @Delete('projects/:projectId/repositories/:repositoryId')
  @HttpCode(204)
  unlink(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string, @Param('repositoryId', ParseUUIDPipe) repositoryId: string) {
    return this.github.unlink(projectId, user.id, repositoryId);
  }

  /** Commits, branches and pull requests that mention the task. */
  @Get('tasks/:taskId/code-links')
  codeLinks(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string) {
    return this.github.codeLinks(taskId, user.id);
  }

  /** GitHub only: push and pull request events, checked with the X-Hub-Signature-256 header. */
  @Public()
  @Post('webhooks/github')
  @HttpCode(202)
  async webhook(@Req() req: RawBodyRequest<Request>, @Headers('x-github-event') event: string, @Headers('x-hub-signature-256') signature: string, @Body() body: unknown) {
    const secret = this.config.get<string>('GITHUB_WEBHOOK_SECRET') ?? '';
    if (!req.rawBody || !verifyWebhookSignature(secret, req.rawBody, signature)) {
      throw Errors.unauthenticated('Invalid webhook signature.');
    }
    return this.webhooks.handle(event ?? '', body as never);
  }
}
