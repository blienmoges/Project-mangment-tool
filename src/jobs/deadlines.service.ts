import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DeliveryStatus, NotificationEvent, ProjectRole } from '@prisma/client';
import { ModuleRef } from '@nestjs/core';
import { Job } from 'bullmq';
import { dateOnly, isoDate, shortId } from '../common/utils';
import { DeliveryService } from '../notifications/delivery.service';
import { formatDay, NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { jobId, QueueService } from './queue.service';
import {
  addDays, firstOverdueMoment, latestOverdueMoment, localDate, nextOverdueMoment, phaseMoment, reminderIsCurrent, reminderMoment,
} from './timing';

const SWEEP_EVERY_MS = 15 * 60 * 1000;
const FALLBACK_SWEEP_MS = 60 * 1000;
const STALE_DELIVERY_MS = 2 * 60 * 1000;
const INVITATION_KEEP_MS = 30 * 24 * 3600 * 1000;

const openTaskWhere = { completedAt: null, project: { archivedAt: null, space: { archivedAt: null } } } as const;

/**
 * Deadline alerts (SRS FR-4.2–FR-4.4, NFR-2; API Design, "Background jobs").
 * Exact-time delayed jobs do the work; the sweep every 15 minutes sends anything that was missed (for example after
 * a restart). Every alert is claimed in the database before it is sent (a task_reminders row, or overdue_notified_at
 * moved forward), so a job and the sweep can never send the same alert twice. Jobs also re-check the task when they
 * run, so a job left over from an old due date does nothing.
 */
@Injectable()
export class DeadlinesService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Deadlines');
  private fallback?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
    private readonly notifications: NotificationsService,
    private readonly delivery: DeliveryService,
    private readonly moduleRef?: ModuleRef,
  ) {}

  onModuleInit() {
    this.queues.process('deadlines', (job: Job) => this.run(job.name, job.data));
  }

  async onApplicationBootstrap() {
    if (this.queues.enabled) {
      await this.queues.every('deadlines', 'safety-sweep', SWEEP_EVERY_MS, 'sweep');
    } else {
      this.logger.warn('JOBS_ENABLED=false: alerts are checked every minute in this process instead of exact-time jobs.');
      this.fallback = setInterval(() => this.sweep().catch((e) => this.logger.error(e)), FALLBACK_SWEEP_MS);
      this.fallback.unref();
    }
    // Catch up straight after a restart.
    setTimeout(() => this.sweep().catch((e) => this.logger.error(e)), 10_000).unref();
  }

  onModuleDestroy() {
    if (this.fallback) clearInterval(this.fallback);
  }

  private run(name: string, data: Record<string, unknown>) {
    const now = new Date();
    switch (name) {
      case 'reminder': return this.runReminder(data.taskId as string, data.daysBefore as number, data.due as string, now);
      case 'overdue': return this.runOverdue(data.taskId as string, data.due as string, now);
      case 'phase': return this.runPhase(data.phaseId as string, data.due as string, now);
      case 'sweep': return this.sweep(now);
      case 'reschedule-workspace': return this.rescheduleWorkspaceNow(data.workspaceId as string);
      default: this.logger.warn(`Unknown deadlines job ${name}`); return Promise.resolve();
    }
  }

  // ───────────── scheduling ─────────────

  /**
   * Schedules the task's reminders and its next overdue alert. Call after a task is created, assigned, reopened or
   * given a new due date (pass the previous due date so its jobs are removed).
   */
  async scheduleTask(taskId: string, previousDue?: string | null) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { dueDate: true, completedAt: true, overdueNotifiedAt: true, workspace: { select: { timezone: true, reminderDays: true } } },
    });
    if (!task) return;
    const { timezone: tz, reminderDays } = task.workspace;
    const due = isoDate(task.dueDate);
    if (previousDue && previousDue !== due) await this.removeTaskJobs(taskId, previousDue, reminderDays, tz);
    if (!due || task.completedAt) return;
    const now = new Date();
    for (const d of reminderDays) {
      const m = reminderMoment(due, d, tz);
      if (m > now || reminderIsCurrent(m, now)) {
        await this.queues.add('deadlines', 'reminder', { taskId, daysBefore: d, due }, { jobId: jobId('rem', taskId, d, due), delay: m.getTime() - now.getTime() });
      }
    }
    const latest = latestOverdueMoment(due, now, tz);
    const missed = latest && (!task.overdueNotifiedAt || task.overdueNotifiedAt < latest);
    await this.scheduleOverdue(taskId, due, missed ? latest : nextOverdueMoment(due, now, tz));
  }

  /** Removes the task's pending jobs (call when it is approved or deleted). Leftover jobs would do nothing anyway. */
  async cancelTask(taskId: string, due: string | null, workspaceId: string) {
    if (!due) return;
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { timezone: true, reminderDays: true } });
    if (ws) await this.removeTaskJobs(taskId, due, ws.reminderDays, ws.timezone);
  }

  async schedulePhase(phaseId: string) {
    const phase = await this.prisma.phase.findUnique({ where: { id: phaseId }, select: { dueDate: true, project: { select: { workspace: { select: { timezone: true } } } } } });
    const due = isoDate(phase?.dueDate);
    if (!phase || !due) return;
    const m = phaseMoment(due, phase.project.workspace.timezone);
    await this.queues.add('deadlines', 'phase', { phaseId, due }, { jobId: jobId('phs', phaseId, due), delay: m.getTime() - Date.now() });
  }

  /** After the workspace's time zone or reminder days change. Runs as a job when the queue is on. */
  async rescheduleWorkspace(workspaceId: string) {
    const queued = await this.queues.add('deadlines', 'reschedule-workspace', { workspaceId }, { jobId: jobId('ws', workspaceId, Date.now()) });
    if (!queued) await this.rescheduleWorkspaceNow(workspaceId);
  }

  private async rescheduleWorkspaceNow(workspaceId: string) {
    const tasks = await this.prisma.task.findMany({ where: { workspaceId, dueDate: { not: null }, ...openTaskWhere }, select: { id: true } });
    for (const t of tasks) await this.scheduleTask(t.id);
    const phases = await this.prisma.phase.findMany({ where: { project: { workspaceId, archivedAt: null }, dueDate: { not: null }, overdueNotifiedAt: null }, select: { id: true } });
    for (const p of phases) await this.schedulePhase(p.id);
  }

  /** The delay is measured from the real clock, whatever moment the caller was working with. */
  private async scheduleOverdue(taskId: string, due: string, at: Date) {
    await this.queues.add('deadlines', 'overdue', { taskId, due }, { jobId: jobId('ovd', taskId, due, at.getTime()), delay: at.getTime() - Date.now() });
  }

  private async removeTaskJobs(taskId: string, due: string, reminderDays: number[], tz: string) {
    for (const d of reminderDays) await this.queues.remove('deadlines', jobId('rem', taskId, d, due));
    await this.queues.remove('deadlines', jobId('ovd', taskId, due, firstOverdueMoment(due, tz).getTime()));
    const next = nextOverdueMoment(due, new Date(), tz);
    await this.queues.remove('deadlines', jobId('ovd', taskId, due, next.getTime()));
  }

  // ───────────── sending ─────────────

  /** "Due in 2 days" to the assignee, once per reminder day (claimed with a task_reminders row). */
  async runReminder(taskId: string, daysBefore: number, due: string, now: Date) {
    const task = await this.loadTask(taskId);
    if (!task || !task.assigneeId || isoDate(task.dueDate) !== due) return false;
    const { timezone: tz, reminderDays } = task.workspace;
    if (!reminderDays.includes(daysBefore)) return false;
    const moment = reminderMoment(due, daysBefore, tz);
    if (!reminderIsCurrent(moment, now)) return false;
    return this.prisma.tx(async (tx) => {
      const claimed = await tx.taskReminder.createMany({ data: [{ taskId, daysBefore }], skipDuplicates: true });
      if (!claimed.count) return false;
      const when = daysBefore === 0 ? 'today' : daysBefore === 1 ? 'tomorrow' : `in ${daysBefore} days`;
      await this.notifications.notify(tx, {
        workspaceId: task.workspaceId, eventType: NotificationEvent.reminder, userIds: [task.assigneeId],
        body: `Reminder: ${task.key} ${task.title} is due ${when} (${formatDay(due)}).`, link: { type: 'task', id: taskId }, triggeredAt: moment,
      });
      return true;
    });
  }

  /** "Overdue" to the assignee and the PM (FR-4.3), then daily at 09:00 until done (FR-4.4). */
  async runOverdue(taskId: string, due: string, now: Date) {
    const task = await this.loadTask(taskId);
    if (!task || isoDate(task.dueDate) !== due) return false;
    const tz = task.workspace.timezone;
    const latest = latestOverdueMoment(due, now, tz);
    if (!latest) {
      // Ran early (clock drift): try again at the right moment.
      await this.scheduleOverdue(taskId, due, firstOverdueMoment(due, tz));
      return false;
    }
    const sent = await this.prisma.tx(async (tx) => {
      const claimed = await tx.task.updateMany({
        where: { id: taskId, completedAt: null, dueDate: dateOnly(due), OR: [{ overdueNotifiedAt: null }, { overdueNotifiedAt: { lt: latest } }] },
        data: { overdueNotifiedAt: now },
      });
      if (!claimed.count) return false;
      const days = Math.round((Date.parse(localDate(now, tz)) - Date.parse(due)) / 86_400_000);
      await this.notifications.notify(tx, {
        workspaceId: task.workspaceId, eventType: NotificationEvent.overdue, userIds: [task.assigneeId, task.managerId],
        body: `${task.key} ${task.title} is overdue: it was due on ${formatDay(due)} (${days} day${days === 1 ? '' : 's'} ago)${task.assigneeId ? '' : ' and has no assignee'}.`,
        link: { type: 'task', id: taskId }, triggeredAt: latest,
      });
      if (latest.getTime() === firstOverdueMoment(due, tz).getTime()) {
        // Custom rules on "task.overdue" run once, with the first alert (looked up lazily: no module cycle).
        const { CustomRulesService } = await import('../automations/custom-rules.service');
        await this.moduleRef?.get(CustomRulesService, { strict: false })?.run(tx, 'task.overdue', { projectId: task.projectId, taskId });
      }
      return true;
    });
    await this.scheduleOverdue(taskId, due, nextOverdueMoment(due, now, tz));
    return sent;
  }

  /** Missed phase (API Design, "Missed phase check"): tells the PM once, if tasks are still unfinished. */
  async runPhase(phaseId: string, due: string, now: Date) {
    const phase = await this.prisma.phase.findUnique({
      where: { id: phaseId },
      include: { project: { select: { id: true, keyPrefix: true, workspaceId: true, archivedAt: true, workspace: { select: { timezone: true } }, members: { where: { role: ProjectRole.project_manager }, select: { userId: true } } } } },
    });
    if (!phase || phase.project.archivedAt || isoDate(phase.dueDate) !== due || phase.overdueNotifiedAt) return false;
    if (now < phaseMoment(due, phase.project.workspace.timezone)) return false;
    const open = await this.prisma.task.count({ where: { phaseId, completedAt: null } });
    if (!open) return false;
    return this.prisma.tx(async (tx) => {
      const claimed = await tx.phase.updateMany({ where: { id: phaseId, overdueNotifiedAt: null, dueDate: dateOnly(due) }, data: { overdueNotifiedAt: now } });
      if (!claimed.count) return false;
      await this.notifications.notify(tx, {
        workspaceId: phase.project.workspaceId, eventType: NotificationEvent.phase_overdue, userIds: phase.project.members.map((m) => m.userId),
        body: `Phase "${phase.name}" of ${phase.project.keyPrefix} was due on ${formatDay(due)} and still has ${open} unfinished task${open === 1 ? '' : 's'}.`,
        link: { type: 'project', id: phase.project.id }, triggeredAt: phaseMoment(due, phase.project.workspace.timezone),
      });
      return true;
    });
  }

  /**
   * The safety sweep: sends every reminder, overdue alert and missed-phase alert that should already have gone out,
   * re-queues email/SMS deliveries that were never handed to the queue, and clears old unused invitations.
   */
  async sweep(now = new Date()) {
    const counts = { reminders: 0, overdue: 0, phases: 0, deliveries: 0, invitations: 0 };
    const workspaces = await this.prisma.workspace.findMany({ select: { id: true, timezone: true, reminderDays: true } });
    for (const ws of workspaces) {
      const today = localDate(now, ws.timezone);
      const maxDays = Math.max(0, ...ws.reminderDays);
      const soon = await this.prisma.task.findMany({
        where: { workspaceId: ws.id, ...openTaskWhere, assigneeId: { not: null }, dueDate: { gte: dateOnly(today), lte: dateOnly(addDays(today, maxDays)) } },
        select: { id: true, dueDate: true, reminders: { select: { daysBefore: true } } },
      });
      for (const t of soon) {
        const due = isoDate(t.dueDate)!;
        for (const d of ws.reminderDays) {
          if (t.reminders.some((r) => r.daysBefore === d) || !reminderIsCurrent(reminderMoment(due, d, ws.timezone), now)) continue;
          if (await this.runReminder(t.id, d, due, now)) counts.reminders++;
        }
      }
      const late = await this.prisma.task.findMany({
        where: { workspaceId: ws.id, ...openTaskWhere, dueDate: { lt: dateOnly(today) } },
        select: { id: true, dueDate: true, overdueNotifiedAt: true },
      });
      for (const t of late) {
        const due = isoDate(t.dueDate)!;
        const latest = latestOverdueMoment(due, now, ws.timezone);
        if (latest && (!t.overdueNotifiedAt || t.overdueNotifiedAt < latest) && (await this.runOverdue(t.id, due, now))) counts.overdue++;
      }
      const phases = await this.prisma.phase.findMany({
        where: { project: { workspaceId: ws.id, archivedAt: null }, overdueNotifiedAt: null, dueDate: { lt: dateOnly(today) } },
        select: { id: true, dueDate: true },
      });
      for (const p of phases) if (await this.runPhase(p.id, isoDate(p.dueDate)!, now)) counts.phases++;
    }
    // Deliveries still "queued" well after creation never reached the queue (for example Redis was down).
    const staleBefore = new Date(now.getTime() - (this.queues.enabled ? STALE_DELIVERY_MS : SWEEP_EVERY_MS));
    const stale = await this.prisma.notificationDelivery.findMany({ where: { status: DeliveryStatus.queued, createdAt: { lt: staleBefore } }, select: { id: true }, take: 500 });
    for (const d of stale) { await this.delivery.dispatch(d.id); counts.deliveries++; }
    counts.invitations = (await this.prisma.invitation.deleteMany({ where: { acceptedAt: null, expiresAt: { lt: new Date(now.getTime() - INVITATION_KEEP_MS) } } })).count;
    if (Object.values(counts).some(Boolean)) this.logger.log(`Sweep: ${JSON.stringify(counts)}`);
    return counts;
  }

  private async loadTask(taskId: string) {
    const t = await this.prisma.task.findFirst({
      where: { id: taskId, ...openTaskWhere },
      select: {
        id: true, number: true, title: true, dueDate: true, assigneeId: true, workspaceId: true, projectId: true,
        workspace: { select: { timezone: true, reminderDays: true } },
        project: { select: { keyPrefix: true, members: { where: { role: ProjectRole.project_manager }, select: { userId: true } } } },
      },
    });
    return t && { ...t, key: shortId(t.project.keyPrefix, t.number), managerId: t.project.members[0]?.userId ?? null };
  }
}
