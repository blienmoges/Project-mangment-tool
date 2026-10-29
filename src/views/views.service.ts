import { Injectable } from '@nestjs/common';
import { ProjectRole } from '@prisma/client';
import { isoDate, shortId, todayInTimeZone } from '../common/utils';
import { addDays } from '../jobs/timing';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { eachDay } from '../sprints/sprint-math';
import { calendarPeriod, loadStatus, mondayOf, spreadHours, weekCapacity } from './view-math';

const userBrief = { id: true, fullName: true, avatarUrl: true } as const;

/** Read-only planning views of a project: timeline (FR-8.1), calendar (FR-8.2) and workload (FR-8.3). */
@Injectable()
export class ViewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
  ) {}

  /** GET /projects/:id/timeline — dated tasks as bars, with dependencies, phases and sprints. */
  async timeline(projectId: string, userId: string) {
    const { project } = await this.projectAccess.require(projectId, userId, 'read');
    const today = todayInTimeZone(project.workspace.timezone);
    const [tasks, deps, phases, sprints] = await Promise.all([
      this.prisma.task.findMany({
        where: { projectId, OR: [{ startDate: { not: null } }, { dueDate: { not: null } }] },
        include: { status: { select: { name: true, category: true, color: true } }, assignee: { select: userBrief } },
        orderBy: [{ startDate: { sort: 'asc', nulls: 'last' } }, { dueDate: 'asc' }, { number: 'asc' }],
      }),
      this.prisma.taskDependency.findMany({ where: { task: { projectId } }, select: { taskId: true, dependsOnTaskId: true } }),
      this.prisma.phase.findMany({ where: { projectId }, orderBy: { position: 'asc' }, select: { id: true, name: true, dueDate: true } }),
      this.prisma.sprint.findMany({ where: { projectId }, orderBy: { startDate: 'asc' }, select: { id: true, name: true, state: true, startDate: true, endDate: true } }),
    ]);
    return {
      project: { id: project.id, name: project.name, startDate: isoDate(project.startDate), endDate: isoDate(project.endDate) },
      today,
      tasks: tasks.map((t) => ({
        id: t.id, shortId: shortId(project.keyPrefix, t.number), title: t.title, parentTaskId: t.parentTaskId, phaseId: t.phaseId,
        // A task with only one date is drawn as a one-day bar on it.
        start: isoDate(t.startDate ?? t.dueDate), end: isoDate(t.dueDate ?? t.startDate),
        status: t.status, assignee: t.assignee, done: !!t.completedAt,
        overdue: !t.completedAt && !!t.dueDate && isoDate(t.dueDate)! < today,
      })),
      dependencies: deps.map((d) => ({ from: d.dependsOnTaskId, to: d.taskId })), // "to" waits for "from"
      phases: phases.map((p) => ({ ...p, dueDate: isoDate(p.dueDate) })),
      sprints: sprints.map((s) => ({ ...s, startDate: isoDate(s.startDate), endDate: isoDate(s.endDate) })),
    };
  }

  /** GET /projects/:id/calendar?view=month|week&date= — tasks on their due dates, plus sprint and phase dates. */
  async calendar(projectId: string, userId: string, view: 'month' | 'week' = 'month', date?: string, assigneeId?: string) {
    const { project } = await this.projectAccess.require(projectId, userId, 'read');
    const today = todayInTimeZone(project.workspace.timezone);
    const { start, end } = calendarPeriod(view, date ?? today);
    const range = { gte: new Date(`${start}T00:00:00Z`), lte: new Date(`${end}T00:00:00Z`) };
    const [tasks, sprints, phases] = await Promise.all([
      this.prisma.task.findMany({
        where: { projectId, dueDate: range, ...(assigneeId ? { assigneeId: assigneeId === 'me' ? userId : assigneeId } : {}) },
        include: { status: { select: { name: true, category: true, color: true } }, assignee: { select: { id: true, fullName: true } } },
        orderBy: [{ priority: 'desc' }, { number: 'asc' }],
      }),
      this.prisma.sprint.findMany({ where: { projectId, OR: [{ startDate: range }, { endDate: range }] }, select: { name: true, startDate: true, endDate: true } }),
      this.prisma.phase.findMany({ where: { projectId, dueDate: range }, select: { name: true, dueDate: true } }),
    ]);
    const month = (date ?? today).slice(0, 7);
    return {
      view, start, end, today,
      days: eachDay(start, end).map((d) => ({
        date: d,
        ...(view === 'month' ? { inMonth: d.slice(0, 7) === month } : {}),
        tasks: tasks.filter((t) => isoDate(t.dueDate) === d).map((t) => ({
          id: t.id, shortId: shortId(project.keyPrefix, t.number), title: t.title, status: t.status.name, statusCategory: t.status.category,
          color: t.status.color, priority: t.priority, overdue: !t.completedAt && d < today, assignee: t.assignee,
        })),
        events: [
          ...sprints.filter((s) => isoDate(s.startDate) === d).map((s) => ({ type: 'sprint_start', label: `${s.name} starts` })),
          ...sprints.filter((s) => isoDate(s.endDate) === d).map((s) => ({ type: 'sprint_end', label: `${s.name} ends` })),
          ...phases.filter((p) => isoDate(p.dueDate) === d).map((p) => ({ type: 'phase_due', label: `${p.name} due` })),
          ...(isoDate(project.endDate) === d ? [{ type: 'project_end', label: `${project.name} ends` }] : []),
        ],
      })),
    };
  }

  /**
   * GET /projects/:id/workload?weeks=4 — per member and week: open work (estimates spread over the working days up to
   * each due date, in all of the person's projects in this workspace), how much of it is this project, and capacity.
   */
  async workload(projectId: string, userId: string, weeks = 4) {
    const { project } = await this.projectAccess.require(projectId, userId, 'manage');
    const tz = project.workspace.timezone;
    const workingDays = project.workspace.workingDays;
    const today = todayInTimeZone(tz);
    const weekStarts = Array.from({ length: weeks }, (_, i) => addDays(mondayOf(today), 7 * i));
    const members = await this.prisma.projectMember.findMany({
      where: { projectId, role: { not: ProjectRole.guest } },
      include: { user: { select: { ...userBrief, weeklyCapacityHours: true } } },
    });
    const tasks = await this.prisma.task.findMany({
      where: { workspaceId: project.workspaceId, completedAt: null, assigneeId: { in: members.map((m) => m.userId) }, project: { archivedAt: null } },
      select: { assigneeId: true, projectId: true, estimatedHours: true, startDate: true, dueDate: true },
    });
    const people = members.map((m) => {
      const own = tasks.filter((t) => t.assigneeId === m.userId);
      const perWeek = weekStarts.map(() => ({ hours: 0, projectHours: 0 }));
      let unscheduled = 0, overdue = 0, noEstimate = 0;
      for (const t of own) {
        const hours = Number(t.estimatedHours ?? 0);
        if (!hours) { noEstimate++; continue; }
        const due = isoDate(t.dueDate);
        if (due && due < today) overdue += hours;
        const { perDay, unscheduled: u } = spreadHours({ hours, startDate: isoDate(t.startDate), dueDate: due }, today, workingDays);
        unscheduled += u;
        for (const [day, h] of perDay) {
          const w = weekStarts.findIndex((s) => day >= s && day <= addDays(s, 6));
          if (w < 0) continue; // beyond the weeks shown
          perWeek[w].hours += h;
          if (t.projectId === projectId) perWeek[w].projectHours += h;
        }
      }
      const r = (n: number) => Math.round(n * 10) / 10;
      return {
        user: { id: m.user.id, fullName: m.user.fullName, avatarUrl: m.user.avatarUrl },
        role: m.role, weeklyCapacityHours: m.user.weeklyCapacityHours,
        weeks: perWeek.map((w, i) => {
          const capacity = weekCapacity(m.user.weeklyCapacityHours, weekStarts[i], today, workingDays);
          return { weekStart: weekStarts[i], hours: r(w.hours), projectHours: r(w.hours > 0 ? w.projectHours : 0), capacityHours: capacity,
            loadPercent: capacity ? Math.round((w.hours / capacity) * 100) : (w.hours ? 100 : 0), status: loadStatus(r(w.hours), capacity) };
        }),
        overdueHours: r(overdue), unscheduledHours: r(unscheduled), tasksWithoutEstimate: noEstimate,
      };
    }).sort((a, b) => a.user.fullName.localeCompare(b.user.fullName));
    return { weeks: weekStarts, today, people };
  }
}
