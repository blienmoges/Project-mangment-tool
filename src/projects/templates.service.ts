import { Injectable } from '@nestjs/common';
import { Prisma, PriorityLevel, SkillLevel, StatusCategory, WorkspaceRole } from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { Errors } from '../common/app-exception';
import { dateOnly, isoDate } from '../common/utils';
import { addDays } from '../jobs/timing';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import { ProjectAccessService } from './project-access.service';

type Tx = Prisma.TransactionClient;

/** What a template stores. Dates are days from the project's start, so they fit any new start date. */
export interface TemplateContent {
  version: 1;
  durationDays: number;
  phases: { name: string; dueOffset: number | null }[];
  tasks: {
    ref: number; parentRef: number | null; title: string; description: string | null; priority: PriorityLevel;
    estimatedHours: number | null; storyPoints: number | null; startOffset: number | null; dueOffset: number | null;
    phase: number | null; skills: { skillId: string; name: string; minLevel: SkillLevel }[]; dependsOn: number[];
  }[];
}

const days = (from: Date, to: Date | null) => (to ? Math.round((to.getTime() - from.getTime()) / 86_400_000) : null);

/** Project templates (SRS FR-1.5). People, progress, comments and time are not copied: a new project starts fresh. */
@Injectable()
export class TemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
    private readonly projectAccess: ProjectAccessService,
    private readonly activity: ActivityService,
  ) {}

  /** POST /projects/:id/template — save the project as a template (PM, Admin). */
  async saveFromProject(projectId: string, userId: string, name: string, description?: string) {
    const { project } = await this.projectAccess.require(projectId, userId, 'manage');
    const clash = await this.prisma.projectTemplate.findFirst({ where: { workspaceId: project.workspaceId, name: { equals: name.trim(), mode: 'insensitive' } } });
    if (clash) throw Errors.conflict('ALREADY_EXISTS', 'A template with this name already exists.');
    const content = await this.snapshot(projectId, project.startDate, project.endDate);
    const t = await this.prisma.projectTemplate.create({
      data: { workspaceId: project.workspaceId, name: name.trim(), description: description?.trim() || null, content: content as unknown as Prisma.InputJsonValue, createdById: userId },
    });
    await this.activity.log({ workspaceId: project.workspaceId, actorId: userId, entityType: 'project', entityId: projectId, action: 'saved_as_template', newValue: { templateId: t.id, name: t.name } });
    return this.out(t);
  }

  /** GET /workspaces/:id/templates */
  async list(workspaceId: string, userId: string) {
    await this.access.requireNonGuest(workspaceId, userId);
    const rows = await this.prisma.projectTemplate.findMany({ where: { workspaceId }, include: { createdBy: { select: { id: true, fullName: true } } }, orderBy: { name: 'asc' } });
    return { data: rows.map((t) => this.out(t)) };
  }

  /** GET /templates/:id — with its phases and tasks, to preview before using it. */
  async get(templateId: string, userId: string) {
    const t = await this.find(templateId);
    await this.access.requireNonGuest(t.workspaceId, userId);
    return { ...this.out(t), content: t.content };
  }

  /** DELETE /templates/:id — the Admin or whoever saved it. */
  async remove(templateId: string, userId: string) {
    const t = await this.find(templateId);
    const m = await this.access.requireNonGuest(t.workspaceId, userId);
    if (m.role !== WorkspaceRole.admin && t.createdById !== userId) throw Errors.forbidden('Only the Workspace Admin or the person who saved the template can delete it.');
    await this.prisma.projectTemplate.delete({ where: { id: templateId } });
  }

  /** Checks a template can be used in a workspace (before the project is created). */
  async forWorkspace(templateId: string, workspaceId: string) {
    const t = await this.prisma.projectTemplate.findUnique({ where: { id: templateId } });
    if (!t || t.workspaceId !== workspaceId) throw Errors.validation({ templateId: 'must be a template of this workspace' });
    return t.content as unknown as TemplateContent;
  }

  /** Creates the template's phases and tasks in a new project (inside the project's transaction). */
  async apply(tx: Tx, project: { id: string; workspaceId: string; spaceId: string; startDate: Date }, content: TemplateContent, userId: string) {
    const start = isoDate(project.startDate)!;
    const on = (offset: number | null) => (offset === null ? null : dateOnly(addDays(start, offset)));
    const phaseIds: string[] = [];
    for (const [i, p] of content.phases.entries()) {
      phaseIds.push((await tx.phase.create({ data: { projectId: project.id, name: p.name, position: i, dueDate: on(p.dueOffset) } })).id);
    }
    const status = await tx.workflowStatus.findFirst({ where: { spaceId: project.spaceId, category: StatusCategory.not_started }, orderBy: { position: 'asc' } });
    const skills = await tx.skill.findMany({ where: { workspaceId: project.workspaceId }, select: { id: true, name: true } });
    const idByRef = new Map<number, string>();
    // Parents first, so subtasks can point to them.
    const ordered = [...content.tasks].sort((a, b) => Number(a.parentRef !== null) - Number(b.parentRef !== null) || a.ref - b.ref);
    for (const t of ordered) {
      const created = await tx.task.create({
        data: {
          workspaceId: project.workspaceId, projectId: project.id, number: idByRef.size + 1, title: t.title, description: t.description,
          priority: t.priority, estimatedHours: t.estimatedHours, storyPoints: t.storyPoints, startDate: on(t.startOffset), dueDate: on(t.dueOffset),
          phaseId: t.phase !== null ? phaseIds[t.phase] ?? null : null, parentTaskId: t.parentRef !== null ? idByRef.get(t.parentRef) ?? null : null,
          statusId: status!.id, createdById: userId,
        },
      });
      idByRef.set(t.ref, created.id);
      // A skill is matched by id, or by name if it was re-created; skills no longer in the catalog are left out.
      const req = t.skills.map((s) => ({ skillId: skills.find((k) => k.id === s.skillId)?.id ?? skills.find((k) => k.name === s.name)?.id, minLevel: s.minLevel })).filter((s): s is { skillId: string; minLevel: SkillLevel } => !!s.skillId);
      if (req.length) await tx.taskSkill.createMany({ data: req.map((s) => ({ taskId: created.id, ...s })), skipDuplicates: true });
    }
    const deps = content.tasks.flatMap((t) => t.dependsOn.map((d) => ({ taskId: idByRef.get(t.ref)!, dependsOnTaskId: idByRef.get(d)! }))).filter((d) => d.taskId && d.dependsOnTaskId && d.taskId !== d.dependsOnTaskId);
    if (deps.length) await tx.taskDependency.createMany({ data: deps, skipDuplicates: true });
    await tx.project.update({ where: { id: project.id }, data: { nextTaskNumber: idByRef.size + 1 } });
    const dated = ordered.filter((t) => t.dueOffset !== null).map((t) => idByRef.get(t.ref)!);
    const datedPhases = content.phases.map((p, i) => (p.dueOffset !== null ? phaseIds[i] : null)).filter((id): id is string => !!id);
    return { phases: phaseIds.length, tasks: idByRef.size, datedTaskIds: dated, datedPhaseIds: datedPhases };
  }

  private async snapshot(projectId: string, start: Date, end: Date): Promise<TemplateContent> {
    const [phases, tasks, deps] = await Promise.all([
      this.prisma.phase.findMany({ where: { projectId }, orderBy: { position: 'asc' } }),
      this.prisma.task.findMany({ where: { projectId }, include: { skills: { include: { skill: { select: { name: true } } } } }, orderBy: { number: 'asc' } }),
      this.prisma.taskDependency.findMany({ where: { task: { projectId } } }),
    ]);
    const ref = new Map(tasks.map((t) => [t.id, t.number]));
    return {
      version: 1,
      durationDays: days(start, end)!,
      phases: phases.map((p) => ({ name: p.name, dueOffset: days(start, p.dueDate) })),
      tasks: tasks.map((t) => ({
        ref: t.number, parentRef: t.parentTaskId ? ref.get(t.parentTaskId) ?? null : null, title: t.title, description: t.description,
        priority: t.priority, estimatedHours: t.estimatedHours === null ? null : Number(t.estimatedHours), storyPoints: t.storyPoints,
        startOffset: days(start, t.startDate), dueOffset: days(start, t.dueDate),
        phase: t.phaseId ? phases.findIndex((p) => p.id === t.phaseId) : null,
        skills: t.skills.map((s) => ({ skillId: s.skillId, name: s.skill.name, minLevel: s.minLevel })),
        dependsOn: deps.filter((d) => d.taskId === t.id).map((d) => ref.get(d.dependsOnTaskId)!).filter((n) => n !== undefined),
      })),
    };
  }

  private async find(id: string) {
    const t = await this.prisma.projectTemplate.findUnique({ where: { id }, include: { createdBy: { select: { id: true, fullName: true } } } });
    if (!t) throw Errors.notFound('Template');
    return t;
  }

  private out(t: { id: string; name: string; description: string | null; content: Prisma.JsonValue; createdAt: Date; createdBy?: { id: string; fullName: string } }) {
    const c = t.content as unknown as TemplateContent;
    return { id: t.id, name: t.name, description: t.description, durationDays: c.durationDays, phases: c.phases.length, tasks: c.tasks.length, createdBy: t.createdBy, createdAt: t.createdAt };
  }
}
