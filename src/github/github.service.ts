import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProjectRole, WorkspaceRole } from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { Errors } from '../common/app-exception';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import { GithubClient } from './github-client';
import { makeInstallState, readInstallState, STATE_MINUTES } from './github-signing';

/** Without the OAuth check, an installation must be this fresh to be connected (see callback()). */
const FRESH_INSTALL_MS = 15 * 60 * 1000;

/** GitHub integration (SRS 3.16): connect a GitHub App installation, link repositories to projects. */
@Injectable()
export class GithubService {
  private readonly logger = new Logger('GitHub');
  private readonly secret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: GithubClient,
    private readonly access: WorkspaceAccessService,
    private readonly projectAccess: ProjectAccessService,
    private readonly activity: ActivityService,
    private readonly config: ConfigService,
  ) {
    this.secret = config.get<string>('JWT_ACCESS_SECRET') ?? '';
  }

  /** GET /workspaces/:id/github — whether GitHub is set up, and the connected accounts. */
  async status(workspaceId: string, userId: string) {
    await this.access.requireNonGuest(workspaceId, userId);
    const installations = await this.prisma.githubInstallation.findMany({ where: { workspaceId }, select: { id: true, accountLogin: true, createdAt: true, _count: { select: { repositories: true } } } });
    return { configured: this.client.configured && !!this.config.get('GITHUB_APP_SLUG'), installations: installations.map(({ _count, ...i }) => ({ ...i, repositories: _count.repositories })) };
  }

  /** GET /workspaces/:id/github/install — the link that starts installing the app (Admin). */
  async installLink(workspaceId: string, userId: string) {
    await this.access.requireAdmin(workspaceId, userId);
    const slug = this.config.get<string>('GITHUB_APP_SLUG');
    if (!slug || !this.client.configured) throw Errors.conflict('GITHUB_NOT_CONFIGURED', 'GitHub is not set up on this server yet (GITHUB_APP_SLUG, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY).');
    const state = makeInstallState(this.secret, workspaceId, userId);
    return { url: `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`, expiresInMinutes: STATE_MINUTES };
  }

  /**
   * GET /github/callback — GitHub sends the browser back here after the installation. The signed state says which
   * Admin started it and for which workspace. To stop someone connecting another organisation's installation (the ids
   * are guessable numbers), the server checks that the person who came back can really access it: with the GitHub
   * App's OAuth settings (GITHUB_CLIENT_ID / SECRET) it asks GitHub; without them (development only) it accepts only an
   * installation created in the last 15 minutes that no workspace has claimed. Returns where to send the browser.
   */
  async callback(q: { installation_id?: string; state?: string; code?: string; setup_action?: string }) {
    const back = (status: string, message?: string) =>
      `${this.webOrigin()}/settings/github?status=${status}${message ? `&message=${encodeURIComponent(message)}` : ''}`;
    try {
      const state = readInstallState(this.secret, q.state);
      if (!state) return back('error', 'The link has expired. Start the installation again from Settings.');
      await this.access.requireAdmin(state.workspaceId, state.userId);
      const installationId = Number(q.installation_id);
      if (!Number.isSafeInteger(installationId) || installationId <= 0) return back('error', 'GitHub did not send an installation.');
      const existing = await this.prisma.githubInstallation.findUnique({ where: { installationId: BigInt(installationId) } });
      if (existing && existing.workspaceId !== state.workspaceId) return back('error', 'This GitHub installation is already connected to another workspace.');
      const installation = await this.client.installation(installationId);
      const clientId = this.config.get<string>('GITHUB_CLIENT_ID');
      const clientSecret = this.config.get<string>('GITHUB_CLIENT_SECRET');
      if (clientId && clientSecret && q.code) {
        const userToken = await this.client.userToken(clientId, clientSecret, q.code);
        const mine = await this.client.userInstallations(userToken);
        if (!mine.installations.some((i) => i.id === installationId)) return back('error', 'Your GitHub account cannot access this installation.');
      } else if (this.config.get('NODE_ENV') === 'production') {
        return back('error', 'The server needs GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to confirm installations.');
      } else if (Date.now() - Date.parse(installation.created_at) > FRESH_INSTALL_MS && !existing) {
        return back('error', 'Only a new installation can be connected. Install the app again from Settings.');
      }
      await this.prisma.githubInstallation.upsert({
        where: { installationId: BigInt(installationId) },
        create: { workspaceId: state.workspaceId, installationId: BigInt(installationId), accountLogin: installation.account.login.slice(0, 100), createdById: state.userId },
        update: { accountLogin: installation.account.login.slice(0, 100) },
      });
      await this.activity.log({ workspaceId: state.workspaceId, actorId: state.userId, entityType: 'workspace', entityId: state.workspaceId, action: 'github_connected', newValue: { account: installation.account.login } });
      return back('connected');
    } catch (e) {
      this.logger.warn(`Callback failed: ${(e as Error).message}`);
      return back('error', 'GitHub could not be connected. Please try again.');
    }
  }

  /** GET /workspaces/:id/github/repositories — repositories the installations can see (Admin, or a PM in the workspace). */
  async repositories(workspaceId: string, userId: string) {
    const m = await this.access.requireNonGuest(workspaceId, userId);
    if (m.role !== WorkspaceRole.admin) {
      const pm = await this.prisma.projectMember.findFirst({ where: { userId, role: ProjectRole.project_manager, project: { workspaceId } } });
      if (!pm) throw Errors.forbidden('Only a Workspace Admin or a Project Manager can see the repositories.');
    }
    const installations = await this.prisma.githubInstallation.findMany({ where: { workspaceId } });
    const out = [];
    for (const inst of installations) {
      let repos;
      try {
        repos = await this.client.repositories(Number(inst.installationId));
      } catch (e) {
        this.logger.warn(`Repositories of ${inst.accountLogin}: ${(e as Error).message}`);
        throw Errors.conflict('GITHUB_UNAVAILABLE', `GitHub did not answer for ${inst.accountLogin}. Try again in a minute.`);
      }
      for (const r of repos) {
        const row = await this.prisma.repository.upsert({
          where: { githubRepoId: BigInt(r.id) },
          create: { installationId: inst.id, githubRepoId: BigInt(r.id), fullName: r.full_name.slice(0, 200) },
          update: { installationId: inst.id, fullName: r.full_name.slice(0, 200) },
          include: { projects: { include: { project: { select: { id: true, name: true, keyPrefix: true } } } } },
        });
        out.push({ id: row.id, fullName: row.fullName, private: r.private, url: r.html_url, account: inst.accountLogin, projects: row.projects.map((p) => p.project) });
      }
    }
    return { data: out.sort((a, b) => a.fullName.localeCompare(b.fullName)) };
  }

  async projectRepositories(projectId: string, userId: string) {
    await this.projectAccess.require(projectId, userId, 'member');
    const rows = await this.prisma.projectRepository.findMany({ where: { projectId }, include: { repository: { select: { id: true, fullName: true } } } });
    return { data: rows.map((r) => ({ ...r.repository, url: `https://github.com/${r.repository.fullName}`, linkedAt: r.createdAt })) };
  }

  /** POST /projects/:id/repositories — { repositoryId } from the repositories list (Admin). */
  async link(projectId: string, userId: string, repositoryId: string) {
    const { project } = await this.projectAccess.require(projectId, userId, 'admin');
    const repo = await this.prisma.repository.findUnique({ where: { id: repositoryId }, include: { installation: { select: { workspaceId: true } } } });
    if (!repo || repo.installation.workspaceId !== project.workspaceId) throw Errors.validation({ repositoryId: 'must be a repository of this workspace\'s GitHub connection (see GET /workspaces/:id/github/repositories)' });
    await this.prisma.projectRepository.createMany({ data: [{ projectId, repositoryId }], skipDuplicates: true });
    await this.activity.log({ workspaceId: project.workspaceId, actorId: userId, entityType: 'project', entityId: projectId, action: 'repository_linked', newValue: { repository: repo.fullName } });
    return this.projectRepositories(projectId, userId);
  }

  async unlink(projectId: string, userId: string, repositoryId: string) {
    const { project } = await this.projectAccess.require(projectId, userId, 'admin');
    const r = await this.prisma.projectRepository.deleteMany({ where: { projectId, repositoryId } });
    if (!r.count) throw Errors.notFound('Linked repository');
    await this.activity.log({ workspaceId: project.workspaceId, actorId: userId, entityType: 'project', entityId: projectId, action: 'repository_unlinked', oldValue: { repositoryId } });
  }

  /** GET /tasks/:id/code-links — commits, branches and pull requests that mention the task. */
  async codeLinks(taskId: string, userId: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId }, select: { projectId: true } });
    if (!task) throw Errors.notFound('Task');
    await this.projectAccess.require(task.projectId, userId, 'member', 'Task');
    const rows = await this.prisma.codeLink.findMany({ where: { taskId }, include: { repository: { select: { fullName: true } } }, orderBy: { updatedAt: 'desc' } });
    return { data: rows.map((r) => ({ id: r.id, kind: r.kind, externalId: r.externalId, title: r.title, url: r.url, state: r.state, repository: r.repository.fullName, createdAt: r.createdAt, updatedAt: r.updatedAt })) };
  }

  private webOrigin() {
    return (this.config.get<string>('WEB_ORIGIN') ?? 'http://localhost:5173').split(',')[0].trim();
  }
}
