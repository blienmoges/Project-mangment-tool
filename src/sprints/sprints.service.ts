import { Injectable } from '@nestjs/common';
import { NotificationEvent, Prisma, ProjectRole, Sprint, SprintState } from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { Errors } from '../common/app-exception';
import { dateOnly, isoDate, todayInTimeZone } from '../common/utils';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { addDays, localDate } from '../jobs/timing';
import { listInclude, TaskViewService } from '../tasks/task-view.service';
import { CompleteSprintDto, CreateSprintDto, UpdateSprintDto } from './dto/sprint.dto';
import { burndown, capacityStatus, defaultEndDate, personCapacityHours, workingDaysIn } from './sprint-math';

const VELOCITY_SPRINTS = 6;
const CAPACITY_SPRINTS = 3;

/** Sprints (SRS 3.12): planned → active → completed, with one active sprint per project. */
@Injectable()
export class SprintsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
    private readonly view: TaskViewService,
    private readonly notifications: NotificationsService,
    private readonly activity: ActivityService,
  ) {}

  /** GET /projects/:id/sprints — newest first, with planned and done points. */
  async list(projectId: string, userId: string) {
    await this.projectAccess.require(projectId, userId, 'member');
    const sprints = await this.prisma.sprint.findMany({ where: { projectId }, orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }] });
    const points = await this.pointsBySprint(sprints.map((s) => s.id));
    return { data: sprints.map((s) => this.out(s, points.get(s.id))) };
  }

  async get(sprintId: string, userId: string) {
    const sprint = await this.findOrFail(sprintId);
    await this.projectAccess.require(sprint.projectId, userId, 'member');
    return this.out(sprint, (await this.pointsBySprint([sprintId])).get(sprintId));
  }

  /** POST /projects/:id/sprints — plan a sprint (two weeks by default, FR-12.1). */
  async create(projectId: string, actorId: string, dto: CreateSprintDto) {
    const { project } = await this.projectAccess.require(projectId, actorId, 'manage');
    this.projectAccess.assertWritable(project);
    let start = dto.startDate;
    if (!start) {
      const last = await this.prisma.sprint.findFirst({ where: { projectId }, orderBy: { endDate: 'desc' }, select: { endDate: true } });
      const today = todayInTimeZone(project.workspace.timezone);
      const afterLast = last ? addDays(isoDate(last.endDate)!, 1) : today;
      start = afterLast > today ? afterLast : today;
    }
    const end = dto.endDate ?? defaultEndDate(start);
    this.checkDates(start, end);
    const sprint = await this.prisma.tx(async (tx) => {
      const created = await tx.sprint.create({
        data: { projectId, name: dto.name.trim(), goal: dto.goal?.trim() || null, startDate: dateOnly(start!), endDate: dateOnly(end) },
      });
      await this.activity.log({ workspaceId: project.workspaceId, actorId, entityType: 'sprint', entityId: created.id, action: 'created', newValue: { name: created.name, startDate: start, endDate: end } }, tx);
      return created;
    });
    return this.out(sprint, { planned: 0, done: 0, tasks: 0, doneTasks: 0 });
  }

  /** PATCH /sprints/:id — name, goal; dates only while not completed. */
  async update(sprintId: string, actorId: string, dto: UpdateSprintDto) {
    const sprint = await this.findOrFail(sprintId);
    const { project } = await this.projectAccess.require(sprint.projectId, actorId, 'manage');
    this.projectAccess.assertWritable(project);
    if ((dto.startDate || dto.endDate) && sprint.state === SprintState.completed) {
      throw Errors.conflict('SPRINT_COMPLETED', 'The dates of a completed sprint cannot change.');
    }
    const start = dto.startDate ?? isoDate(sprint.startDate)!;
    const end = dto.endDate ?? isoDate(sprint.endDate)!;
    this.checkDates(start, end);
    const updated = await this.prisma.sprint.update({
      where: { id: sprintId },
      data: {
        ...(dto.name ? { name: dto.name.trim() } : {}),
        ...(dto.goal !== undefined ? { goal: dto.goal?.trim() || null } : {}),
        startDate: dateOnly(start), endDate: dateOnly(end),
      },
    });
    await this.activity.log({
      workspaceId: project.workspaceId, actorId, entityType: 'sprint', entityId: sprintId, action: 'updated',
      oldValue: { name: sprint.name, goal: sprint.goal, startDate: isoDate(sprint.startDate), endDate: isoDate(sprint.endDate) },
      newValue: { name: updated.name, goal: updated.goal, startDate: start, endDate: end },
    });
    return this.get(sprintId, actorId);
  }

  /** DELETE /sprints/:id — only a planned sprint; its tasks go back to the backlog. */
  async remove(sprintId: string, actorId: string) {
    const sprint = await this.findOrFail(sprintId);
    const { project } = await this.projectAccess.require(sprint.projectId, actorId, 'manage');
    this.projectAccess.assertWritable(project);
    if (sprint.state !== SprintState.planned) throw Errors.conflict('SPRINT_NOT_PLANNED', 'Only a sprint that has not started can be deleted.');
    await this.prisma.tx(async (tx) => {
      const moved = await tx.task.updateMany({ where: { sprintId }, data: { sprintId: null } });
      await tx.sprint.delete({ where: { id: sprintId } });
      await this.activity.log({ workspaceId: project.workspaceId, actorId, entityType: 'sprint', entityId: sprintId, action: 'deleted', oldValue: { name: sprint.name }, newValue: { tasksToBacklog: moved.count } }, tx);
    });
  }

  /** POST /sprints/:id/start — refused while another sprint of the project is active (FR-12.4). */
  async start(sprintId: string, actorId: string) {
    const sprint = await this.findOrFail(sprintId);
    const { project } = await this.projectAccess.require(sprint.projectId, actorId, 'manage');
    this.projectAccess.assertWritable(project);
    if (sprint.state !== SprintState.planned) throw Errors.conflict('SPRINT_NOT_PLANNED', 'Only a planned sprint can be started.');
    const active = await this.prisma.sprint.findFirst({ where: { projectId: sprint.projectId, state: SprintState.active }, select: { name: true } });
    if (active) throw Errors.conflict('SPRINT_ALREADY_ACTIVE', `"${active.name}" is still active. Complete it before starting another sprint.`);
    try {
      await this.prisma.tx(async (tx) => {
        await tx.sprint.update({ where: { id: sprintId }, data: { state: SprintState.active, startedAt: new Date() } });
        const [points, members] = await Promise.all([
          tx.task.aggregate({ where: { sprintId }, _sum: { storyPoints: true }, _count: { _all: true } }),
          tx.projectMember.findMany({ where: { projectId: sprint.projectId, role: { not: ProjectRole.guest } }, select: { userId: true } }),
        ]);
        await this.activity.log({ workspaceId: project.workspaceId, actorId, entityType: 'sprint', entityId: sprintId, action: 'started', newValue: { plannedPoints: points._sum.storyPoints ?? 0, tasks: points._count._all } }, tx);
        // Roles guide P6: "the team is notified and the burndown chart starts".
        await this.notifications.notify(tx, {
          workspaceId: project.workspaceId, eventType: NotificationEvent.sprint_started, userIds: members.map((m) => m.userId), actorId,
          body: `${sprint.name} of ${project.keyPrefix} has started: ${points._count._all} tasks, ${points._sum.storyPoints ?? 0} story points, until ${isoDate(sprint.endDate)}.${sprint.goal ? ` Goal: ${sprint.goal}` : ''}`,
          link: { type: 'project', id: sprint.projectId },
        });
      });
    } catch (e) {
      // The partial unique index sprints_one_active catches two starts at the same moment.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw Errors.conflict('SPRINT_ALREADY_ACTIVE', 'Another sprint of this project was started at the same moment.');
      }
      throw e;
    }
    return this.get(sprintId, actorId);
  }

  /**
   * POST /sprints/:id/complete — saves the completed points (for velocity) and moves unfinished tasks to the backlog
   * or to a planned sprint (FR-12.5).
   */
  async complete(sprintId: string, actorId: string, dto: CompleteSprintDto) {
    const sprint = await this.findOrFail(sprintId);
    const { project } = await this.projectAccess.require(sprint.projectId, actorId, 'manage');
    this.projectAccess.assertWritable(project);
    if (sprint.state !== SprintState.active) throw Errors.conflict('SPRINT_NOT_ACTIVE', 'Only the active sprint can be completed.');
    let target: string | null = null;
    if (dto.moveUnfinishedTo !== 'backlog') {
      const next = await this.prisma.sprint.findUnique({ where: { id: dto.moveUnfinishedTo } });
      if (!next || next.projectId !== sprint.projectId || next.id === sprintId || next.state !== SprintState.planned) {
        throw Errors.validation({ moveUnfinishedTo: 'must be "backlog" or a planned sprint of the same project' });
      }
      target = next.id;
    }
    await this.prisma.tx(async (tx) => {
      const done = await tx.task.aggregate({ where: { sprintId, completedAt: { not: null } }, _sum: { storyPoints: true }, _count: { _all: true } });
      const unfinished = await tx.task.findMany({ where: { sprintId, completedAt: null }, select: { id: true, storyPoints: true } });
      await tx.task.updateMany({ where: { id: { in: unfinished.map((t) => t.id) } }, data: { sprintId: target } });
      const completedPoints = done._sum.storyPoints ?? 0;
      await tx.sprint.update({ where: { id: sprintId }, data: { state: SprintState.completed, completedAt: new Date(), completedPoints } });
      await this.activity.log(
        {
          workspaceId: project.workspaceId, actorId, entityType: 'sprint', entityId: sprintId, action: 'completed',
          // movedTaskIds lets the burndown of a completed sprint still show the work that was not finished.
          newValue: { completedPoints, doneTasks: done._count._all, movedTaskIds: unfinished.map((t) => t.id), movedPoints: unfinished.reduce((s, t) => s + (t.storyPoints ?? 0), 0), movedTo: target ?? 'backlog' },
        },
        tx,
      );
    });
    return this.get(sprintId, actorId);
  }

  /** GET /sprints/:id/burndown — remaining points at the end of each day, and the ideal line (FR-12.6). */
  async burndown(sprintId: string, userId: string) {
    const sprint = await this.findOrFail(sprintId);
    const { project } = await this.projectAccess.require(sprint.projectId, userId, 'member');
    const tz = project.workspace.timezone;
    const ids = new Set((await this.prisma.task.findMany({ where: { sprintId }, select: { id: true } })).map((t) => t.id));
    if (sprint.state === SprintState.completed) {
      const log = await this.prisma.activityLog.findFirst({ where: { entityType: 'sprint', entityId: sprintId, action: 'completed' }, orderBy: { createdAt: 'desc' } });
      for (const id of ((log?.newValue as { movedTaskIds?: string[] } | null)?.movedTaskIds ?? [])) ids.add(id);
    }
    const tasks = await this.prisma.task.findMany({ where: { id: { in: [...ids] } }, select: { storyPoints: true, completedAt: true, sprintId: true } });
    // A moved-out task that was finished later in another sprint does not count as done in this one.
    const doneOn = (t: (typeof tasks)[number]) => (t.completedAt && (t.sprintId === sprintId || (sprint.completedAt && t.completedAt <= sprint.completedAt)) ? localDate(t.completedAt, tz) : null);
    const lastDay = sprint.completedAt ? localDate(sprint.completedAt, tz) : todayInTimeZone(tz);
    const chart = burndown(isoDate(sprint.startDate)!, isoDate(sprint.endDate)!, lastDay, tasks.map((t) => ({ points: t.storyPoints ?? 0, doneOn: doneOn(t) })));
    return { sprint: { id: sprint.id, name: sprint.name, state: sprint.state }, ...chart };
  }

  /** GET /projects/:id/velocity — completed points of the last six sprints (FR-12.7). */
  async velocity(projectId: string, userId: string) {
    await this.projectAccess.require(projectId, userId, 'member');
    const sprints = await this.prisma.sprint.findMany({ where: { projectId, state: SprintState.completed }, orderBy: { completedAt: 'desc' }, take: VELOCITY_SPRINTS });
    const data = sprints.reverse().map((s) => ({ id: s.id, name: s.name, startDate: isoDate(s.startDate), endDate: isoDate(s.endDate), completedPoints: s.completedPoints ?? 0 }));
    const average = data.length ? Math.round((data.reduce((s, x) => s + x.completedPoints, 0) / data.length) * 10) / 10 : null;
    return { data, averagePoints: average };
  }

  /** GET /projects/:id/backlog — unfinished tasks in no sprint, highest priority first (FR-12.2). */
  async backlog(projectId: string, userId: string) {
    const { project } = await this.projectAccess.require(projectId, userId, 'member');
    const rows = await this.prisma.task.findMany({
      where: { projectId, sprintId: null, completedAt: null },
      include: listInclude,
      orderBy: [{ priority: 'desc' }, { dueDate: { sort: 'asc', nulls: 'last' } }, { number: 'asc' }],
      take: 500,
    });
    const data = await this.view.list(rows, project.workspace.timezone);
    return { data, totalPoints: data.reduce((s, t) => s + (t.storyPoints ?? 0), 0), totalHours: data.reduce((s, t) => s + (t.estimatedHours ?? 0), 0) };
  }

  /** GET /sprints/:id/capacity — planned work against what the team can do (API Design, "Sprint capacity"; FR-12.3). */
  async capacity(sprintId: string, userId: string) {
    const sprint = await this.findOrFail(sprintId);
    const { project } = await this.projectAccess.require(sprint.projectId, userId, 'member');
    const start = isoDate(sprint.startDate)!;
    const end = isoDate(sprint.endDate)!;
    const workingDays = project.workspace.workingDays;
    const sprintDays = workingDaysIn(start, end, workingDays);
    const [planned, history, members] = await Promise.all([
      this.prisma.task.aggregate({ where: { sprintId }, _sum: { storyPoints: true, estimatedHours: true } }),
      this.prisma.sprint.findMany({ where: { projectId: sprint.projectId, state: SprintState.completed, id: { not: sprintId } }, orderBy: { completedAt: 'desc' }, take: CAPACITY_SPRINTS, select: { completedPoints: true } }),
      this.prisma.projectMember.findMany({
        where: { projectId: sprint.projectId, role: { not: ProjectRole.guest } },
        include: { user: { select: { id: true, fullName: true, weeklyCapacityHours: true } } },
      }),
    ]);
    const other = await this.prisma.task.groupBy({
      by: ['assigneeId'],
      where: { workspaceId: project.workspaceId, projectId: { not: sprint.projectId }, completedAt: null, assigneeId: { in: members.map((m) => m.userId) }, dueDate: { gte: sprint.startDate, lte: sprint.endDate } },
      _sum: { estimatedHours: true },
    });
    const people = members.map((m) => {
      const otherHours = Number(other.find((o) => o.assigneeId === m.userId)?._sum.estimatedHours ?? 0);
      return { id: m.user.id, fullName: m.user.fullName, weeklyCapacityHours: m.user.weeklyCapacityHours, otherProjectHours: otherHours,
        capacityHours: personCapacityHours(m.user.weeklyCapacityHours, sprintDays, workingDays.length, otherHours) };
    }).sort((a, b) => a.fullName.localeCompare(b.fullName));
    const plannedPoints = planned._sum.storyPoints ?? 0;
    const plannedHours = Number(planned._sum.estimatedHours ?? 0);
    const capacityPoints = history.length ? Math.round((history.reduce((s, h) => s + (h.completedPoints ?? 0), 0) / history.length) * 10) / 10 : null;
    const capacityHours = Math.round(people.reduce((s, p) => s + p.capacityHours, 0) * 10) / 10;
    return {
      sprintId, workingDays: sprintDays, plannedPoints, capacityPoints, plannedHours, capacityHours,
      comparedBy: capacityPoints !== null ? 'points' : 'hours',
      status: capacityPoints !== null ? capacityStatus(plannedPoints, capacityPoints) : capacityStatus(plannedHours, capacityHours),
      people,
    };
  }

  // ───────────── helpers ─────────────

  private async findOrFail(sprintId: string) {
    const sprint = await this.prisma.sprint.findUnique({ where: { id: sprintId } });
    if (!sprint) throw Errors.notFound('Sprint');
    return sprint;
  }

  private checkDates(start: string, end: string) {
    if (end <= start) throw Errors.validation({ endDate: 'must be after startDate' });
  }

  private async pointsBySprint(ids: string[]) {
    const out = new Map<string, { planned: number; done: number; tasks: number; doneTasks: number }>(ids.map((id) => [id, { planned: 0, done: 0, tasks: 0, doneTasks: 0 }]));
    if (!ids.length) return out;
    const [all, done] = await Promise.all([
      this.prisma.task.groupBy({ by: ['sprintId'], where: { sprintId: { in: ids } }, _sum: { storyPoints: true }, _count: { _all: true } }),
      this.prisma.task.groupBy({ by: ['sprintId'], where: { sprintId: { in: ids }, completedAt: { not: null } }, _sum: { storyPoints: true }, _count: { _all: true } }),
    ]);
    for (const r of all) if (r.sprintId) Object.assign(out.get(r.sprintId)!, { planned: r._sum.storyPoints ?? 0, tasks: r._count._all });
    for (const r of done) if (r.sprintId) Object.assign(out.get(r.sprintId)!, { done: r._sum.storyPoints ?? 0, doneTasks: r._count._all });
    return out;
  }

  private out(s: Sprint, p?: { planned: number; done: number; tasks: number; doneTasks: number }) {
    return {
      id: s.id, projectId: s.projectId, name: s.name, goal: s.goal, state: s.state,
      startDate: isoDate(s.startDate), endDate: isoDate(s.endDate), startedAt: s.startedAt, completedAt: s.completedAt,
      // For a completed sprint, the stored figure: unfinished tasks have moved on since.
      completedPoints: s.state === SprintState.completed ? (s.completedPoints ?? 0) : (p?.done ?? 0),
      plannedPoints: p?.planned ?? 0,
      tasks: p?.tasks ?? 0, doneTasks: p?.doneTasks ?? 0,
    };
  }
}
