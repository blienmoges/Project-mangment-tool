import { Injectable } from '@nestjs/common';
import { Prisma, StatusCategory, TimeSource } from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { Errors } from '../common/app-exception';
import { isoDate, shortId, todayInTimeZone } from '../common/utils';
import { addDays, localDate, zonedTime } from '../jobs/timing';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { toCsv } from './csv';
import { ManualEntryDto, TimeReportQuery, UpdateEntryDto } from './dto/time.dto';

type Tx = Prisma.TransactionClient;
const userBrief = { id: true, fullName: true } as const;
/** Manual entries are stored at noon on their day, so the day stays the same in every time zone view. */
const NOON = { h: 12, m: 0 };

/** Minutes between two instants, at least 1 (the database requires minutes > 0). */
export const timerMinutes = (start: Date, end: Date) => Math.max(1, Math.round((end.getTime() - start.getTime()) / 60_000));

/** Time tracking (SRS 3.13): one running timer per person, manual entries, estimate versus logged, reports. */
@Injectable()
export class TimeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
    private readonly activity: ActivityService,
  ) {}

  /** POST /tasks/:id/timer/start — the assignee or the PM; refused while the caller has a timer running. */
  async start(taskId: string, userId: string, note?: string) {
    const { task, workspaceId } = await this.loggable(taskId, userId);
    const running = await this.prisma.timeEntry.findFirst({ where: { userId, endedAt: null }, include: { task: { select: { number: true, title: true, project: { select: { keyPrefix: true } } } } } });
    if (running) {
      throw Errors.conflict('TIMER_RUNNING', `Your timer is already running on ${shortId(running.task.project.keyPrefix, running.task.number)} ${running.task.title}. Stop it first.`);
    }
    try {
      const entry = await this.prisma.timeEntry.create({ data: { taskId, userId, startedAt: new Date(), source: TimeSource.timer, note: note?.trim() || null } });
      await this.activity.log({ workspaceId, actorId: userId, entityType: 'task', entityId: task.id, action: 'timer_started', newValue: { entryId: entry.id } });
      return this.timer(userId);
    } catch (e) {
      // time_entries_one_running: a second start at the same moment.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw Errors.conflict('TIMER_RUNNING', 'Your timer is already running.');
      throw e;
    }
  }

  /** POST /timer/stop — saves the minutes of the caller's running timer. */
  async stop(userId: string) {
    const running = await this.prisma.timeEntry.findFirst({ where: { userId, endedAt: null } });
    if (!running) throw Errors.conflict('NO_TIMER_RUNNING', 'You have no timer running.');
    const endedAt = new Date();
    const entry = await this.prisma.timeEntry.update({ where: { id: running.id }, data: { endedAt, minutes: timerMinutes(running.startedAt, endedAt) }, include: { user: { select: userBrief } } });
    return this.entryOut(entry);
  }

  /** Stops every running timer on a task (when it is approved). Used by the tasks module inside its transaction. */
  async stopTimersOnTask(tx: Tx, taskId: string) {
    const running = await tx.timeEntry.findMany({ where: { taskId, endedAt: null } });
    const now = new Date();
    for (const r of running) await tx.timeEntry.update({ where: { id: r.id }, data: { endedAt: now, minutes: timerMinutes(r.startedAt, now) } });
    return running.length;
  }

  /** GET /timer — the caller's running timer, or { running: false }. */
  async timer(userId: string) {
    const t = await this.prisma.timeEntry.findFirst({
      where: { userId, endedAt: null },
      include: { task: { select: { id: true, number: true, title: true, project: { select: { id: true, keyPrefix: true, name: true } } } } },
    });
    if (!t) return { running: false };
    return {
      running: true, entryId: t.id, startedAt: t.startedAt, note: t.note,
      elapsedSeconds: Math.floor((Date.now() - t.startedAt.getTime()) / 1000),
      task: { id: t.task.id, shortId: shortId(t.task.project.keyPrefix, t.task.number), title: t.task.title, project: t.task.project },
    };
  }

  /** GET /tasks/:id/time-entries — entries plus estimate versus logged (FR-13.3). */
  async list(taskId: string, userId: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId }, select: { projectId: true, estimatedHours: true } });
    if (!task) throw Errors.notFound('Task');
    await this.projectAccess.require(task.projectId, userId, 'member', 'Task');
    const entries = await this.prisma.timeEntry.findMany({ where: { taskId }, include: { user: { select: userBrief } }, orderBy: { startedAt: 'desc' } });
    const logged = entries.reduce((s, e) => s + (e.minutes ?? 0), 0);
    const estimated = task.estimatedHours === null ? null : Math.round(Number(task.estimatedHours) * 60);
    const byPerson = new Map<string, { user: { id: string; fullName: string }; minutes: number }>();
    for (const e of entries) {
      const p = byPerson.get(e.userId) ?? { user: e.user, minutes: 0 };
      p.minutes += e.minutes ?? 0;
      byPerson.set(e.userId, p);
    }
    return {
      data: entries.map((e) => this.entryOut(e)),
      summary: {
        estimatedMinutes: estimated, loggedMinutes: logged,
        remainingMinutes: estimated === null ? null : Math.max(0, estimated - logged),
        overEstimate: estimated !== null && logged > estimated,
        byPerson: [...byPerson.values()].sort((a, b) => b.minutes - a.minutes),
      },
    };
  }

  /** POST /tasks/:id/time-entries — add time by hand: { minutes, date, note }. */
  async addManual(taskId: string, userId: string, dto: ManualEntryDto) {
    const { workspaceId, tz } = await this.loggable(taskId, userId, true);
    if (dto.date > todayInTimeZone(tz)) throw Errors.validation({ date: 'cannot be in the future' });
    const startedAt = zonedTime(dto.date, NOON, tz);
    const entry = await this.prisma.timeEntry.create({
      data: { taskId, userId, startedAt, endedAt: new Date(startedAt.getTime() + dto.minutes * 60_000), minutes: dto.minutes, source: TimeSource.manual, note: dto.note?.trim() || null },
      include: { user: { select: userBrief } },
    });
    await this.activity.log({ workspaceId, actorId: userId, entityType: 'task', entityId: taskId, action: 'time_logged', newValue: { minutes: dto.minutes, date: dto.date } });
    return this.entryOut(entry);
  }

  /** PATCH /time-entries/:id — own entries; the minutes and date of a running timer change when it stops. */
  async update(entryId: string, userId: string, dto: UpdateEntryDto) {
    const { entry, tz } = await this.own(entryId, userId);
    if ((dto.minutes !== undefined || dto.date !== undefined) && !entry.endedAt) throw Errors.conflict('TIMER_RUNNING', 'Stop the timer before changing its time.');
    if (dto.date && dto.date > todayInTimeZone(tz)) throw Errors.validation({ date: 'cannot be in the future' });
    const minutes = dto.minutes ?? entry.minutes ?? 1;
    const startedAt = dto.date ? zonedTime(dto.date, NOON, tz) : entry.startedAt;
    const updated = await this.prisma.timeEntry.update({
      where: { id: entryId },
      data: {
        ...(dto.note !== undefined ? { note: dto.note?.trim() || null } : {}),
        ...(dto.minutes !== undefined || dto.date !== undefined ? { minutes, startedAt, endedAt: new Date(startedAt.getTime() + minutes * 60_000) } : {}),
      },
      include: { user: { select: userBrief } },
    });
    return this.entryOut(updated);
  }

  /** DELETE /time-entries/:id — own entries (deleting a running timer cancels it). */
  async remove(entryId: string, userId: string) {
    await this.own(entryId, userId);
    await this.prisma.timeEntry.delete({ where: { id: entryId } });
  }

  /** GET /projects/:id/time-report — hours per person, task and sprint (FR-13.4); ?format=csv for a file. */
  async report(projectId: string, userId: string, q: TimeReportQuery) {
    const { project } = await this.projectAccess.require(projectId, userId, 'manage');
    const tz = project.workspace.timezone;
    const from = q.from ?? isoDate(project.startDate)!;
    const to = q.to ?? todayInTimeZone(tz);
    if (to < from) throw Errors.validation({ to: 'must be on or after from' });
    const entries = await this.prisma.timeEntry.findMany({
      where: { task: { projectId }, minutes: { not: null }, startedAt: { gte: zonedTime(from, { h: 0, m: 0 }, tz), lt: zonedTime(addDays(to, 1), { h: 0, m: 0 }, tz) } },
      include: { user: { select: userBrief }, task: { select: { id: true, number: true, title: true, sprint: { select: { id: true, name: true } } } } },
      orderBy: { startedAt: 'asc' },
    });
    const hours = (m: number) => Math.round((m / 60) * 100) / 100;
    if (q.format === 'csv') {
      const csv = toCsv(
        ['Date', 'Person', 'Task', 'Title', 'Sprint', 'Hours', 'Source', 'Note'],
        entries.map((e) => [localDate(e.startedAt, tz), e.user.fullName, shortId(project.keyPrefix, e.task.number), e.task.title, e.task.sprint?.name ?? 'Backlog', hours(e.minutes!), e.source, e.note ?? '']),
      );
      return { csv, fileName: `${project.keyPrefix}-time-${from}-to-${to}.csv` };
    }
    const group = <K extends string>(key: (e: (typeof entries)[number]) => K, label: (e: (typeof entries)[number]) => object) => {
      const m = new Map<K, { minutes: number; info: object }>();
      for (const e of entries) { const k = key(e); const g = m.get(k) ?? { minutes: 0, info: label(e) }; g.minutes += e.minutes!; m.set(k, g); }
      return [...m.values()].map((g) => ({ ...g.info, hours: hours(g.minutes) })).sort((a, b) => b.hours - a.hours);
    };
    const total = entries.reduce((s, e) => s + e.minutes!, 0);
    return {
      from, to, totalHours: hours(total),
      byPerson: group((e) => e.userId, (e) => ({ user: e.user })),
      byTask: group((e) => e.taskId, (e) => ({ task: { id: e.task.id, shortId: shortId(project.keyPrefix, e.task.number), title: e.task.title } })),
      bySprint: group((e) => e.task.sprint?.id ?? 'backlog', (e) => ({ sprint: e.task.sprint ?? { id: null, name: 'Backlog' } })),
    };
  }

  // ───────────── helpers ─────────────

  /** Time can be logged by the task's assignee or the PM / Admin, on open tasks of writable projects. */
  private async loggable(taskId: string, userId: string, allowClosed = false) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId }, select: { id: true, projectId: true, assigneeId: true, status: { select: { category: true } } } });
    if (!task) throw Errors.notFound('Task');
    const access = await this.projectAccess.require(task.projectId, userId, 'member', 'Task');
    this.projectAccess.assertWritable(access.project);
    if (task.assigneeId !== userId && !access.isAdmin && !access.isManager) throw Errors.forbidden('Only the assignee or the Project Manager can log time on this task.');
    if (!allowClosed && task.status.category === StatusCategory.closed) throw Errors.conflict('TASK_CLOSED', 'This task is finished; add the time by hand instead.');
    return { task, workspaceId: access.project.workspaceId, tz: access.project.workspace.timezone };
  }

  private async own(entryId: string, userId: string) {
    const entry = await this.prisma.timeEntry.findUnique({ where: { id: entryId }, include: { task: { select: { projectId: true } } } });
    if (!entry || entry.userId !== userId) throw Errors.notFound('Time entry');
    const { project } = await this.projectAccess.require(entry.task.projectId, userId, 'member', 'Time entry');
    this.projectAccess.assertWritable(project);
    return { entry, tz: project.workspace.timezone };
  }

  private entryOut(e: { id: string; taskId: string; user: { id: string; fullName: string }; startedAt: Date; endedAt: Date | null; minutes: number | null; source: TimeSource; note: string | null }) {
    return { id: e.id, taskId: e.taskId, user: e.user, startedAt: e.startedAt, endedAt: e.endedAt, minutes: e.minutes, running: !e.endedAt, source: e.source, note: e.note };
  }
}

