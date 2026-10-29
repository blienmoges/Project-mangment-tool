import { Injectable } from '@nestjs/common';
import { IssueStatus, IssueType, Prisma, ProjectRole, StatusCategory } from '@prisma/client';
import { isoDate, shortId } from '../common/utils';
import { PrismaService } from '../prisma/prisma.service';
import { todayFor } from '../projects/project-stats';
import { allowedTargets, Actor } from './task-workflow';

const userBrief = { id: true, fullName: true, avatarUrl: true } as const;
const statusBrief = { id: true, name: true, category: true, color: true, position: true } as const;
const OPEN_ISSUE: IssueStatus[] = [IssueStatus.open, IssueStatus.in_progress];

/** Fields loaded for list rows. */
export const listInclude = {
  status: { select: statusBrief },
  assignee: { select: userBrief },
  project: { select: { keyPrefix: true } },
  _count: { select: { subtasks: true } },
} satisfies Prisma.TaskInclude;
type ListTask = Prisma.TaskGetPayload<{ include: typeof listInclude }>;

export interface TaskFlags {
  blocked: Set<string>;
  /** taskId → number of tasks it depends on that are not finished. */
  waitingOn: Map<string, number>;
  /** parentTaskId → finished subtasks. */
  doneSubtasks: Map<string, number>;
}

/** Turns task rows into API responses, with the calculated fields: shortId, overdue, blocked, waitingOn. */
@Injectable()
export class TaskViewService {
  constructor(private readonly prisma: PrismaService) {}

  async flags(taskIds: string[]): Promise<TaskFlags> {
    if (!taskIds.length) return { blocked: new Set(), waitingOn: new Map(), doneSubtasks: new Map() };
    const [blockers, deps, done] = await Promise.all([
      this.prisma.issue.findMany({ where: { taskId: { in: taskIds }, type: IssueType.blocker, status: { in: OPEN_ISSUE } }, select: { taskId: true } }),
      this.prisma.taskDependency.findMany({ where: { taskId: { in: taskIds }, dependsOn: { completedAt: null } }, select: { taskId: true } }),
      this.prisma.task.groupBy({ by: ['parentTaskId'], where: { parentTaskId: { in: taskIds }, completedAt: { not: null } }, _count: { _all: true } }),
    ]);
    const waitingOn = new Map<string, number>();
    for (const d of deps) waitingOn.set(d.taskId, (waitingOn.get(d.taskId) ?? 0) + 1);
    return {
      blocked: new Set(blockers.map((b) => b.taskId!)),
      waitingOn,
      doneSubtasks: new Map(done.map((d) => [d.parentTaskId!, d._count._all])),
    };
  }

  listItem(t: ListTask, flags: TaskFlags, today: Date) {
    return {
      id: t.id,
      shortId: shortId(t.project.keyPrefix, t.number),
      number: t.number,
      title: t.title,
      status: t.status,
      priority: t.priority,
      assignee: t.assignee,
      acceptance: t.acceptance,
      phaseId: t.phaseId,
      sprintId: t.sprintId,
      parentTaskId: t.parentTaskId,
      estimatedHours: t.estimatedHours === null ? null : Number(t.estimatedHours),
      storyPoints: t.storyPoints,
      startDate: isoDate(t.startDate),
      dueDate: isoDate(t.dueDate),
      completedAt: t.completedAt,
      overdue: !t.completedAt && !!t.dueDate && t.dueDate < today,
      blocked: flags.blocked.has(t.id),
      waitingOn: flags.waitingOn.get(t.id) ?? 0,
      subtasks: { total: t._count.subtasks, done: flags.doneSubtasks.get(t.id) ?? 0 },
      updatedAt: t.updatedAt,
    };
  }

  async list(rows: ListTask[], timezone: string) {
    const flags = await this.flags(rows.map((r) => r.id));
    const today = todayFor(timezone);
    return rows.map((r) => this.listItem(r, flags, today));
  }

  /** Full task page (GET /tasks/:id). `viewer` decides the permissions object and the allowed status moves. */
  async detail(taskId: string, viewer: { userId: string; canManage: boolean; writable: boolean; timezone: string }) {
    const t = await this.prisma.task.findUniqueOrThrow({
      where: { id: taskId },
      include: {
        ...listInclude,
        project: { select: { id: true, name: true, keyPrefix: true, spaceId: true } },
        createdBy: { select: userBrief },
        phase: { select: { id: true, name: true, dueDate: true } },
        sprint: { select: { id: true, name: true, state: true } },
        parent: { select: { id: true, number: true, title: true } },
        subtasks: { include: { status: { select: statusBrief }, assignee: { select: userBrief } }, orderBy: { number: 'asc' } },
        skills: { include: { skill: { select: { id: true, name: true, category: true } } } },
        dependencies: { include: { dependsOn: { select: { id: true, number: true, title: true, completedAt: true, status: { select: statusBrief } } } } },
        dependents: { include: { task: { select: { id: true, number: true, title: true, completedAt: true, status: { select: statusBrief } } } } },
        fieldValues: { include: { field: { select: { id: true, name: true, fieldType: true } } } },
      },
    });
    const [flags, statuses, blockers, manager] = await Promise.all([
      this.flags([t.id]),
      this.prisma.workflowStatus.findMany({ where: { spaceId: t.project.spaceId }, orderBy: { position: 'asc' } }),
      this.prisma.issue.findMany({ where: { taskId: t.id, type: IssueType.blocker, status: { in: OPEN_ISSUE } }, select: { id: true, title: true, severity: true } }),
      this.prisma.projectMember.findFirst({ where: { projectId: t.projectId, role: ProjectRole.project_manager }, select: { userId: true } }),
    ]);
    const key = (n: number) => shortId(t.project.keyPrefix, n);
    const today = todayFor(viewer.timezone);
    const base = this.listItem({ ...t, project: { keyPrefix: t.project.keyPrefix } }, flags, today);
    const isAssignee = t.assigneeId === viewer.userId;
    const actor: Actor = { isManager: viewer.canManage, isAssignee };
    const state = { blocked: base.blocked, unfinishedDependencies: base.waitingOn };
    const cat = t.status.category;
    const firstReview = statuses.find((s) => s.category === StatusCategory.review);
    const moves = viewer.writable && (actor.isManager || isAssignee) ? allowedTargets(statuses, t.status, actor, state) : [];
    const open = cat !== StatusCategory.closed;
    return {
      ...base,
      description: t.description,
      project: { id: t.project.id, name: t.project.name, keyPrefix: t.project.keyPrefix },
      concernNote: t.concernNote,
      createdBy: t.createdBy,
      createdAt: t.createdAt,
      phase: t.phase ? { ...t.phase, dueDate: isoDate(t.phase.dueDate) } : null,
      sprint: t.sprint,
      parent: t.parent ? { id: t.parent.id, shortId: key(t.parent.number), title: t.parent.title } : null,
      subtaskList: t.subtasks.map((s) => ({ id: s.id, shortId: key(s.number), title: s.title, status: s.status, assignee: s.assignee, completedAt: s.completedAt })),
      requiredSkills: t.skills.map((s) => ({ skillId: s.skillId, name: s.skill.name, category: s.skill.category, minLevel: s.minLevel })),
      dependsOn: t.dependencies.map((d) => ({ id: d.dependsOn.id, shortId: key(d.dependsOn.number), title: d.dependsOn.title, status: d.dependsOn.status, done: !!d.dependsOn.completedAt })),
      blocking: t.dependents.map((d) => ({ id: d.task.id, shortId: key(d.task.number), title: d.task.title, status: d.task.status, done: !!d.task.completedAt })),
      blockers,
      customFields: t.fieldValues.map((v) => ({ fieldId: v.fieldId, name: v.field.name, fieldType: v.field.fieldType, value: v.value })),
      managerId: manager?.userId ?? null,
      permissions: {
        canEdit: viewer.canManage && viewer.writable,
        canAssign: viewer.canManage && viewer.writable && open,
        canRespond: isAssignee && viewer.writable && open, // accept or flag a concern
        canSubmit: !!firstReview && moves.includes(firstReview.id),
        canApprove: viewer.canManage && viewer.writable && cat === StatusCategory.review && !base.blocked,
        canRequestChanges: viewer.canManage && viewer.writable && cat === StatusCategory.review,
        canReopen: viewer.canManage && viewer.writable && cat === StatusCategory.closed,
        /** Status ids POST /status accepts from this caller right now. */
        allowedMoves: moves,
      },
    };
  }
}
