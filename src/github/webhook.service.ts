import { Injectable, Logger } from '@nestjs/common';
import { ActorType, CodeLinkKind, CodeLinkState, Prisma } from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { AutomationsService } from '../automations/automations.service';
import { CustomRulesService } from '../automations/custom-rules.service';
import { PrismaService } from '../prisma/prisma.service';
import { findTaskKeys } from './github-signing';

type Tx = Prisma.TransactionClient;
const MAX_COMMITS = 100;

interface Repo { id: number; html_url?: string; full_name?: string }
interface Payload {
  action?: string;
  installation?: { id: number };
  repository?: Repo;
  ref?: string; deleted?: boolean;
  commits?: { id: string; message: string; url: string }[];
  pull_request?: { number: number; title: string; body: string | null; html_url: string; state: string; merged: boolean; head: { ref: string } };
  repositories_removed?: { id: number }[];
}

/**
 * POST /webhooks/github (SRS FR-16.1–16.3). The signature is checked by the controller. Links are upserts, so GitHub's
 * redeliveries change nothing. Only repositories linked to a project are used, and a key such as MBA-42 only matches a
 * task of a project linked to that repository.
 */
@Injectable()
export class WebhookService {
  private readonly logger = new Logger('GitHubWebhook');

  constructor(
    private readonly prisma: PrismaService,
    private readonly automations: AutomationsService,
    private readonly activity: ActivityService,
    private readonly rules?: CustomRulesService,
  ) {}

  async handle(event: string, p: Payload): Promise<{ linked: number; moved: number; note?: string }> {
    const none = (note: string) => ({ linked: 0, moved: 0, note });
    if (event === 'ping') return none('pong');
    if (!p.installation?.id) return none('no installation');
    const inst = await this.prisma.githubInstallation.findUnique({ where: { installationId: BigInt(p.installation.id) } });
    if (!inst) return none('installation not connected to any workspace');

    if (event === 'installation' && p.action === 'deleted') {
      await this.prisma.githubInstallation.delete({ where: { id: inst.id } }); // repositories and code links go with it
      return none('installation removed');
    }
    if (event === 'installation_repositories' && p.action === 'removed') {
      await this.prisma.repository.deleteMany({ where: { installationId: inst.id, githubRepoId: { in: (p.repositories_removed ?? []).map((r) => BigInt(r.id)) } } });
      return none('repositories removed');
    }
    if ((event !== 'push' && event !== 'pull_request') || !p.repository) return none(`ignored ${event}`);

    const repo = await this.prisma.repository.upsert({
      where: { githubRepoId: BigInt(p.repository.id) },
      create: { installationId: inst.id, githubRepoId: BigInt(p.repository.id), fullName: (p.repository.full_name ?? String(p.repository.id)).slice(0, 200) },
      update: {},
      include: { projects: { include: { project: { select: { id: true, keyPrefix: true } } } } },
    });
    if (repo.installationId !== inst.id) return none('repository belongs to another installation');
    const projects = new Map(repo.projects.map((r) => [r.project.keyPrefix, r.project.id]));
    if (!projects.size) return none('repository not linked to a project');
    const repoUrl = p.repository.html_url ?? `https://github.com/${repo.fullName}`;

    return this.prisma.tx(async (tx) => {
      let linked = 0, moved = 0;
      const save = async (keys: string[], kind: CodeLinkKind, externalId: string, title: string, url: string, state: CodeLinkState) => {
        for (const taskId of await this.tasksFor(tx, keys, projects)) {
          const before = await tx.codeLink.findUnique({ where: { taskId_repositoryId_kind_externalId: { taskId, repositoryId: repo.id, kind, externalId } }, select: { state: true } });
          await tx.codeLink.upsert({
            where: { taskId_repositoryId_kind_externalId: { taskId, repositoryId: repo.id, kind, externalId } },
            create: { taskId, repositoryId: repo.id, kind, externalId, title, url, state },
            update: { title, url, state },
          });
          if (!before || before.state !== state) {
            linked++;
            await this.activity.log({ workspaceId: inst.workspaceId, actorType: ActorType.github, entityType: 'task', entityId: taskId, action: before ? 'code_link_updated' : 'code_linked', newValue: { kind, externalId, state, repository: repo.fullName } }, tx);
          }
          if (kind === CodeLinkKind.pull_request && state === CodeLinkState.merged && before?.state !== CodeLinkState.merged) {
            if (await this.automations.onPullRequestMerged(tx, taskId, `#${externalId}`)) moved++;
            if (this.rules) {
              const t = await tx.task.findUnique({ where: { id: taskId }, select: { projectId: true } });
              if (t) await this.rules.run(tx, 'pull_request.merged', { projectId: t.projectId, taskId });
            }
          }
        }
      };
      if (event === 'push') {
        const branch = (p.ref ?? '').replace(/^refs\/heads\//, '');
        if (branch && p.ref?.startsWith('refs/heads/')) {
          await save(findTaskKeys(branch), CodeLinkKind.branch, branch.slice(0, 64), branch, `${repoUrl}/tree/${encodeURI(branch)}`, p.deleted ? CodeLinkState.closed : CodeLinkState.pushed);
        }
        for (const c of (p.commits ?? []).slice(0, MAX_COMMITS)) {
          await save(findTaskKeys(c.message), CodeLinkKind.commit, c.id.slice(0, 64), c.message.split('\n')[0].slice(0, 300), c.url, CodeLinkState.pushed);
        }
      } else if (p.pull_request) {
        const pr = p.pull_request;
        const state = pr.merged ? CodeLinkState.merged : pr.state === 'closed' ? CodeLinkState.closed : CodeLinkState.open;
        await save(findTaskKeys(pr.title, pr.head.ref, pr.body), CodeLinkKind.pull_request, String(pr.number), `#${pr.number} ${pr.title}`.slice(0, 300), pr.html_url, state);
      }
      return { linked, moved };
    });
  }

  /** Task ids for keys like MBA-42, only in projects linked to the repository. */
  private async tasksFor(tx: Tx, keys: string[], projects: Map<string, string>) {
    const ids: string[] = [];
    for (const key of keys) {
      const [prefix, num] = key.split('-');
      const projectId = projects.get(prefix);
      if (!projectId) continue;
      const t = await tx.task.findUnique({ where: { projectId_number: { projectId, number: Number(num) } }, select: { id: true } });
      if (t && !ids.includes(t.id)) ids.push(t.id);
    }
    return ids;
  }
}
