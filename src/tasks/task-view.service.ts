import { Injectable } from '@nestjs/common';
import { AcceptanceState, Prisma, ProjectRole, StatusCategory } from '@prisma/client';
import { isoDate, shortId } from '../common/utils';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccess } from '../projects/project-access.service';
import { todayFor } from '../projects/project-stats';
import { OPEN_ISSUE_STATUSES, TaskAccessService } from './task-access.service';
import { checkApprove, checkReopen, checkRequestChanges, checkStatusMove, firstOf, MoveContext } from './workflow-rules';

export const userBrief = { id: true, fullName: true, avatarUrl: true } as const;
const statusBrief = { id: true, name: true, category: true, color: true } as const;

export const listInclude = {
  status: { select: statusBrief },
  assignee: { select: userBrief },
  _count: { select: { subtasks: true } },
} satisfies Prisma.TaskInclude;

const detailInclude = {
  status: { select: statusBrief },
  assignee: { select: userBrief },
  createdBy: { select: userBrief },
  phase: { select: { id: true, name: true } },
  sprint: { select: { id: true, name: true, state: true } },
  parent: { select: { id: true, number: true, title: true } },
  subtasks: {
    select: { id: true, number: true, title: true, dueDate: true, completedAt: true, status: { select: statusBrief }, assignee: { select: userBrief } },
    orderBy: { number: 'asc' },
  },
  skills: { include: { skill: { select: { id: true, name: true, category: true } } } },
  dependencies: { include: { dependsOn: { select: { id: true, number: true, title: true, completedAt: true, status: { select: statusBrief } } } } },
  dependents: { include: { task: { select: { id: true, number: true, title: true, completedAt: true } } } },
  fieldValues: true,
} satisfies Prisma.TaskInclude;

type ListTask = Prisma.TaskGetPayload<{ include: typeof listInclude }>;

/** Builds the task shapes the API returns (dates as YYYY-MM-DD, calculated overdue, blocked and shortId). */
@Injectable()
export class TaskViewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly taskAccess: TaskAccessService,
  ) {}

  listItem(t: ListTask, keyPrefix: string, today: Date, blocked: Set<string>) {
    return {
      id: t.id,
      shortId: shortId(keyPrefix, t.number),
      number: t.number,
      title: t.title,
      status: t.status,
      priority: t.priority,
      assignee: t.assignee,
      acceptance: t.acceptance,
      phaseId: t.phaseId,
      sprintId: t.sprintId,
      parentTaskId: t.parentTaskId,
      subtaskCount: t._count.subtasks,
      estimatedHours: t.estimatedHours === null ? null : Number(t.estimatedHours),
      storyPoints: t.storyPoints,
      startDate: isoDate(t.startDate),
      dueDate: isoDate(t.dueDate),
      completedAt: t.completedAt,
      overdue: !t.completedAt && !!t.dueDate && t.dueDate < today,
      blocked: blocked.has(t.id),
      updatedAt: t.updatedAt,
    };
  }

  /** GET /tasks/:id — everything the task screen needs, plus what the caller may do with it. */
  async detail(taskId: string, userId: string, access: ProjectAccess) {
    const { project } = access;
    const task = await this.prisma.task.findUniqueOrThrow({ where: { id: taskId }, include: detailInclude });
    const [statuses, fields, blockers, issueCount] = await Promise.all([
      this.prisma.workflowStatus.findMany({ where: { spaceId: project.spaceId }, orderBy: { position: 'asc' } }),
      this.prisma.customField.findMany({ where: { spaceId: project.spaceId }, orderBy: { position: 'asc' } }),
      this.prisma.issue.findMany({
        where: { taskId, type: 'blocker', status: { in: OPEN_ISSUE_STATUSES } },
        select: { id: true, title: true, severity: true, status: true },
      }),
      this.prisma.issue.count({ where: { taskId, status: { in: OPEN_ISSUE_STATUSES } } }),
    ]);
    const today = todayFor(project.workspace.timezone);
    const key = (n: number) => shortId(project.keyPrefix, n);
    const waitingOn = task.dependencies.filter((d) => !d.dependsOn.completedAt).length;
    const current = statuses.find((s) => s.id === task.statusId)!;
    const isManager = access.isAdmin || access.isManager;
    const isAssignee = task.assigneeId === userId;
    const writable = !project.space.archivedAt && !project.archivedAt;
    const canWork = writable && (isManager || (!!access.projectMember && access.projectMember.role !== ProjectRole.guest));
    const ctx: MoveContext = { from: current, isManager, isAssignee, blocked: blockers.length > 0, dependenciesDone: waitingOn === 0 };
    const review = firstOf(statuses, StatusCategory.review);
    const closed = firstOf(statuses, StatusCategory.closed);
    const active = firstOf(statuses, StatusCategory.active);
    const isClosed = current.category === StatusCategory.closed;
    const isOpenForAcceptance = isAssignee && !isClosed && (task.acceptance === AcceptanceState.pending || task.acceptance === AcceptanceState.concern);
    const { skills, dependencies, dependents, fieldValues, subtasks, parent, statusId, assigneeId, createdById, phaseId, sprintId, ...rest } = task;

    return {
      ...rest,
      shortId: key(task.number),
      estimatedHours: task.estimatedHours === null ? null : Number(task.estimatedHours),
      startDate: isoDate(task.startDate),
      dueDate: isoDate(task.dueDate),
      overdue: !task.completedAt && !!task.dueDate && task.dueDate < today,
      blocked: blockers.length > 0,
      blockers,
      openIssues: issueCount,
      project: { id: project.id, name: project.name, keyPrefix: project.keyPrefix, spaceId: project.spaceId },
      parent: parent ? { id: parent.id, shortId: key(parent.number), title: parent.title } : null,
      subtasks: subtasks.map((s) => ({ ...s, shortId: key(s.number), dueDate: isoDate(s.dueDate) })),
      requiredSkills: skills.map((s) => ({ skillId: s.skillId, name: s.skill.name, category: s.skill.category, minLevel: s.minLevel })),
      dependencies: dependencies.map((d) => ({ id: d.dependsOn.id, shortId: key(d.dependsOn.number), title: d.dependsOn.title, status: d.dependsOn.status, done: !!d.dependsOn.completedAt })),
      dependents: dependents.map((d) => ({ id: d.task.id, shortId: key(d.task.number), title: d.task.title, done: !!d.task.completedAt })),
      waitingOnDependencies: waitingOn,
      customFields: fields.map((f) => ({ fieldId: f.id, name: f.name, fieldType: f.fieldType, options: f.options, value: fieldValues.find((v) => v.fieldId === f.id)?.value ?? null })),
      permissions: {
        canEdit: writable && isManager,
        canAssign: writable && isManager && !isClosed,
        canAccept: writable && isOpenForAcceptance && task.acceptance !== AcceptanceState.accepted,
        canFlagConcern: writable && isAssignee && !isClosed,
        canSubmit: canWork && !!review && current.category !== StatusCategory.review && !checkStatusMove(ctx, review),
        canApprove: canWork && !!closed && !checkApprove(ctx, closed),
        canRequestChanges: canWork && !!active && !checkRequestChanges(ctx, active),
        canReopen: canWork && !!active && !checkReopen(ctx, active),
      },
      /** Statuses the caller may move the task to with POST /tasks/:id/status. */
      allowedMoves: canWork ? statuses.filter((s) => s.id !== current.id && !checkStatusMove(ctx, s)).map((s) => s.id) : [],
    };
  }
}
