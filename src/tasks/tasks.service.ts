import { Injectable } from '@nestjs/common';
import { Prisma, SprintState, StatusCategory } from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { Errors } from '../common/app-exception';
import { dateOnly, isoDate, shortId, unique } from '../common/utils';
import { DomainEventsService } from '../events/domain-events.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService, ProjectWithSpace } from '../projects/project-access.service';
import { overdueWhere, todayFor } from '../projects/project-stats';
import { checkFieldValue } from '../spaces/custom-field-values';
import { AddDependencyDto, CreateTaskDto, RequiredSkillDto, TaskListQuery, UpdateTaskDto } from './dto/task.dto';
import { TaskAccessService } from './task-access.service';
import { listInclude, TaskViewService } from './task-view.service';

type Tx = Prisma.TransactionClient;
const CATEGORIES = Object.values(StatusCategory) as string[];
const SHORT_ID = /^([A-Za-z][A-Za-z0-9]{1,4})-(\d+)$/;

/** Tasks (SRS 3.2): create, list, edit and delete; subtasks, required skills, dependencies and custom field values. */
@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
    private readonly taskAccess: TaskAccessService,
    private readonly view: TaskViewService,
    private readonly activity: ActivityService,
    private readonly events: DomainEventsService,
  ) {}

  /** GET /projects/:id/tasks — filters, sorting and cursor paging ({ data, nextCursor }). */
  async list(projectId: string, userId: string, q: TaskListQuery) {
    const { project } = await this.projectAccess.require(projectId, userId, 'read');
    const today = todayFor(project.workspace.timezone);
    const where: Prisma.TaskWhereInput = { projectId };
    const and: Prisma.TaskWhereInput[] = [];

    if (q.status) {
      if (CATEGORIES.includes(q.status)) where.status = { category: q.status as StatusCategory };
      else if (/^[0-9a-f-]{36}$/i.test(q.status)) where.statusId = q.status;
      else throw Errors.validation({ status: 'must be a status id or one of: not_started, active, review, closed' });
    }
    if (q.assigneeId) where.assigneeId = q.assigneeId === 'me' ? userId : q.assigneeId === 'none' ? null : q.assigneeId;
    if (q.phaseId) where.phaseId = q.phaseId === 'none' ? null : q.phaseId;
    if (q.sprintId) where.sprintId = q.sprintId === 'backlog' ? null : q.sprintId;
    if (q.parentTaskId) where.parentTaskId = q.parentTaskId;
    else if (q.topLevel) where.parentTaskId = null;
    if (q.priority) where.priority = q.priority;
    if (q.overdue) and.push(overdueWhere(today));
    if (q.q) {
      const m = SHORT_ID.exec(q.q.trim());
      if (m && m[1].toUpperCase() === project.keyPrefix) where.number = Number(m[2]);
      else and.push({ OR: [{ title: { contains: q.q, mode: 'insensitive' } }, { description: { contains: q.q, mode: 'insensitive' } }] });
    }
    if (q.fieldId) and.push({ fieldValues: { some: { fieldId: q.fieldId, ...(q.fieldValue !== undefined ? { value: { equals: this.parseFieldFilter(q.fieldValue) } } : {}) } } });
    if (and.length) where.AND = and;

    const sort = q.sort ?? 'number';
    const field = sort.replace('-', '') as 'dueDate' | 'priority' | 'createdAt' | 'updatedAt' | 'number';
    const dir = sort.startsWith('-') ? 'desc' : 'asc';
    const orderBy: Prisma.TaskOrderByWithRelationInput[] = [
      field === 'dueDate' ? { dueDate: { sort: dir, nulls: 'last' } } : { [field]: dir },
      { id: 'asc' },
    ];
    const limit = q.limit ?? 25;
    const rows = await this.prisma.task.findMany({
      where,
      include: listInclude,
      orderBy,
      take: limit + 1,
      ...(q.cursor ? { cursor: { id: this.decodeCursor(q.cursor) }, skip: 1 } : {}),
    });
    const page = rows.slice(0, limit);
    const blocked = await this.taskAccess.blockedIds(page.map((t) => t.id));
    return {
      data: page.map((t) => this.view.listItem(t, project.keyPrefix, today, blocked)),
      nextCursor: rows.length > limit ? Buffer.from(page[page.length - 1].id).toString('base64url') : null,
    };
  }

  /** POST /projects/:id/tasks — PM or Admin. Starts in the first Not started status unless statusId says otherwise. */
  async create(projectId: string, actorId: string, dto: CreateTaskDto) {
    const access = await this.projectAccess.require(projectId, actorId, 'manage');
    const { project } = access;
    this.projectAccess.assertWritable(project);
    this.checkDates(dto.startDate, dto.dueDate);
    await this.checkRefs(project, dto);
    if (dto.parentTaskId) await this.checkParent(projectId, dto.parentTaskId);
    const statusId = await this.startStatus(project.spaceId, dto.statusId);
    const skills = await this.checkSkills(project.workspaceId, dto.requiredSkills ?? []);
    const values = await this.checkFieldValues(project.spaceId, dto.customFields);

    const task = await this.prisma.$transaction(async (tx) => {
      // Reserve the next task number (the row lock makes concurrent creates safe).
      const { nextTaskNumber } = await tx.project.update({ where: { id: projectId }, data: { nextTaskNumber: { increment: 1 } }, select: { nextTaskNumber: true } });
      const created = await tx.task.create({
        data: {
          workspaceId: project.workspaceId,
          projectId,
          number: nextTaskNumber - 1,
          title: dto.title.trim(),
          description: dto.description?.trim() || null,
          statusId,
          phaseId: dto.phaseId ?? null,
          sprintId: dto.sprintId ?? null,
          parentTaskId: dto.parentTaskId ?? null,
          priority: dto.priority ?? undefined,
          estimatedHours: dto.estimatedHours ?? null,
          storyPoints: dto.storyPoints ?? null,
          startDate: dto.startDate ? dateOnly(dto.startDate) : null,
          dueDate: dto.dueDate ? dateOnly(dto.dueDate) : null,
          createdById: actorId,
        },
      });
      if (skills.length) await tx.taskSkill.createMany({ data: skills.map((s) => ({ taskId: created.id, skillId: s.skillId, minLevel: s.minLevel })) });
      await this.writeFieldValues(tx, created.id, values);
      await this.activity.log(
        {
          workspaceId: project.workspaceId, actorId, entityType: 'task', entityId: created.id, action: 'created',
          newValue: { shortId: shortId(project.keyPrefix, created.number), title: created.title, dueDate: dto.dueDate ?? null },
        },
        tx,
      );
      return created;
    });
    this.events.emit({ type: 'task.created', workspaceId: project.workspaceId, projectId, taskId: task.id, actorId, data: { dueDate: dto.dueDate ?? null } });
    return this.view.detail(task.id, actorId, access);
  }

  async get(taskId: string, userId: string) {
    const { access } = await this.taskAccess.require(taskId, userId, 'read');
    return this.view.detail(taskId, userId, access);
  }

  /** GET /tasks/by-key/MBA-42 */
  async byKey(key: string, userId: string, workspaceId?: string) {
    const m = SHORT_ID.exec(key.trim());
    if (!m) throw Errors.validation({ shortId: 'must look like MBA-42' });
    const projects = await this.prisma.project.findMany({
      where: { keyPrefix: m[1].toUpperCase(), workspace: { members: { some: { userId } } }, ...(workspaceId ? { workspaceId } : {}) },
      select: { id: true },
    });
    if (!projects.length) throw Errors.notFound('Task');
    if (projects.length > 1) throw Errors.validation({ workspaceId: 'several of your workspaces use this key prefix; send workspaceId' });
    const task = await this.prisma.task.findUnique({ where: { projectId_number: { projectId: projects[0].id, number: Number(m[2]) } }, select: { id: true } });
    if (!task) throw Errors.notFound('Task');
    const { access } = await this.taskAccess.require(task.id, userId, 'member');
    return this.view.detail(task.id, userId, access);
  }

  /** PATCH /tasks/:id — details, dates, phase, sprint, parent, estimates and custom field values (PM, Admin). */
  async update(taskId: string, actorId: string, dto: UpdateTaskDto) {
    const { task, access } = await this.taskAccess.require(taskId, actorId, 'manage');
    const { project } = access;
    this.projectAccess.assertWritable(project);
    const start = dto.startDate !== undefined ? dto.startDate : isoDate(task.startDate);
    const due = dto.dueDate !== undefined ? dto.dueDate : isoDate(task.dueDate);
    this.checkDates(start, due);
    await this.checkRefs(project, dto);
    if (dto.parentTaskId) {
      if (dto.parentTaskId === taskId) throw Errors.validation({ parentTaskId: 'a task cannot be its own parent' });
      await this.checkParent(task.projectId, dto.parentTaskId);
      if (await this.prisma.task.count({ where: { parentTaskId: taskId } })) {
        throw Errors.validation({ parentTaskId: 'a task that has subtasks cannot become a subtask (subtasks are one level deep)' });
      }
    }
    const values = await this.checkFieldValues(project.spaceId, dto.customFields);

    const data: Prisma.TaskUncheckedUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title.trim();
    if (dto.description !== undefined) data.description = dto.description?.trim() || null;
    if (dto.priority !== undefined) data.priority = dto.priority;
    if (dto.estimatedHours !== undefined) data.estimatedHours = dto.estimatedHours;
    if (dto.storyPoints !== undefined) data.storyPoints = dto.storyPoints;
    if (dto.phaseId !== undefined) data.phaseId = dto.phaseId;
    if (dto.sprintId !== undefined) data.sprintId = dto.sprintId;
    if (dto.parentTaskId !== undefined) data.parentTaskId = dto.parentTaskId;
    if (dto.startDate !== undefined) data.startDate = dto.startDate ? dateOnly(dto.startDate) : null;
    const dueChanged = dto.dueDate !== undefined && dto.dueDate !== isoDate(task.dueDate);
    if (dueChanged) {
      data.dueDate = dto.dueDate ? dateOnly(dto.dueDate) : null;
      data.overdueNotifiedAt = null; // reminders and overdue alerts start again for the new date
    }

    const changes = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.task.update({ where: { id: taskId }, data });
      if (dueChanged) await tx.taskReminder.deleteMany({ where: { taskId } });
      await this.writeFieldValues(tx, taskId, values);
      const diff = this.diff(task, updated);
      if (values.length) diff.newValue.customFields = Object.fromEntries(values.map((v) => [v.fieldId, v.value as Prisma.InputJsonValue]));
      if (Object.keys(diff.newValue).length) {
        await this.activity.log({ workspaceId: project.workspaceId, actorId, entityType: 'task', entityId: taskId, action: 'updated', ...diff }, tx);
      }
      return diff;
    });
    if (Object.keys(changes.newValue).length) {
      this.events.emit({ type: 'task.updated', workspaceId: project.workspaceId, projectId: task.projectId, taskId, actorId, data: { changed: Object.keys(changes.newValue) } });
    }
    if (dueChanged) {
      this.events.emit({ type: 'task.due_date_changed', workspaceId: project.workspaceId, projectId: task.projectId, taskId, actorId, data: { from: isoDate(task.dueDate), to: dto.dueDate ?? null } });
    }
    return this.view.detail(taskId, actorId, access);
  }

  /** DELETE /tasks/:id — also deletes its subtasks. */
  async remove(taskId: string, actorId: string) {
    const { task, access } = await this.taskAccess.require(taskId, actorId, 'manage');
    this.projectAccess.assertWritable(access.project);
    const subtasks = await this.prisma.task.findMany({ where: { parentTaskId: taskId }, select: { id: true } });
    await this.prisma.$transaction(async (tx) => {
      await tx.task.delete({ where: { id: taskId } });
      await this.activity.log(
        {
          workspaceId: task.workspaceId, actorId, entityType: 'task', entityId: taskId, action: 'deleted',
          oldValue: { shortId: shortId(access.project.keyPrefix, task.number), title: task.title, subtasksDeleted: subtasks.length },
        },
        tx,
      );
    });
    for (const id of [taskId, ...subtasks.map((s) => s.id)]) {
      this.events.emit({ type: 'task.deleted', workspaceId: task.workspaceId, projectId: task.projectId, taskId: id, actorId });
    }
  }

  /** PUT /tasks/:id/skills — replaces the required skills. */
  async setSkills(taskId: string, actorId: string, input: RequiredSkillDto[]) {
    const { task, access } = await this.taskAccess.require(taskId, actorId, 'manage');
    this.projectAccess.assertWritable(access.project);
    const skills = await this.checkSkills(task.workspaceId, input);
    await this.prisma.$transaction(async (tx) => {
      await tx.taskSkill.deleteMany({ where: { taskId } });
      if (skills.length) await tx.taskSkill.createMany({ data: skills.map((s) => ({ taskId, skillId: s.skillId, minLevel: s.minLevel })) });
      await this.activity.log({ workspaceId: task.workspaceId, actorId, entityType: 'task', entityId: taskId, action: 'skills_changed', newValue: { requiredSkills: skills.map((s) => ({ ...s })) } }, tx);
    });
    return this.view.detail(taskId, actorId, access);
  }

  /** POST /tasks/:id/dependencies — this task waits for another task of the same project; loops are refused. */
  async addDependency(taskId: string, actorId: string, dto: AddDependencyDto) {
    const { task, access } = await this.taskAccess.require(taskId, actorId, 'manage');
    this.projectAccess.assertWritable(access.project);
    const other = await this.prisma.task.findUnique({ where: { id: dto.dependsOnTaskId } });
    if (!other || other.projectId !== task.projectId) throw Errors.validation({ dependsOnTaskId: 'must be another task of the same project' });
    if (other.id === taskId) throw Errors.conflict('DEPENDENCY_LOOP', 'A task cannot depend on itself.');
    const exists = await this.prisma.taskDependency.findUnique({ where: { taskId_dependsOnTaskId: { taskId, dependsOnTaskId: other.id } } });
    if (!exists) {
      const edges = await this.prisma.taskDependency.findMany({ where: { task: { projectId: task.projectId } }, select: { taskId: true, dependsOnTaskId: true } });
      if (wouldCreateLoop(edges, taskId, other.id)) {
        throw Errors.conflict('DEPENDENCY_LOOP', `${shortId(access.project.keyPrefix, other.number)} already depends on this task, directly or through other tasks.`);
      }
      await this.prisma.$transaction(async (tx) => {
        await tx.taskDependency.create({ data: { taskId, dependsOnTaskId: other.id } });
        await this.activity.log({ workspaceId: task.workspaceId, actorId, entityType: 'task', entityId: taskId, action: 'dependency_added', newValue: { dependsOnTaskId: other.id } }, tx);
      });
    }
    return this.view.detail(taskId, actorId, access);
  }

  async removeDependency(taskId: string, actorId: string, otherTaskId: string) {
    const { task, access } = await this.taskAccess.require(taskId, actorId, 'manage');
    this.projectAccess.assertWritable(access.project);
    const where = { taskId_dependsOnTaskId: { taskId, dependsOnTaskId: otherTaskId } };
    if (!(await this.prisma.taskDependency.findUnique({ where }))) throw Errors.notFound('Dependency');
    await this.prisma.$transaction(async (tx) => {
      await tx.taskDependency.delete({ where });
      await this.activity.log({ workspaceId: task.workspaceId, actorId, entityType: 'task', entityId: taskId, action: 'dependency_removed', oldValue: { dependsOnTaskId: otherTaskId } }, tx);
    });
  }

  /** GET /me/tasks — the caller's open tasks across all projects, soonest due first. */
  async myTasks(userId: string, workspaceId?: string) {
    const rows = await this.prisma.task.findMany({
      where: { assigneeId: userId, completedAt: null, project: { archivedAt: null, space: { archivedAt: null } }, ...(workspaceId ? { workspaceId } : {}) },
      include: {
        status: { select: { id: true, name: true, category: true, color: true } },
        project: { select: { id: true, name: true, keyPrefix: true, workspaceId: true, workspace: { select: { timezone: true } } } },
      },
      orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { priority: 'desc' }, { createdAt: 'asc' }],
      take: 200,
    });
    const blocked = await this.taskAccess.blockedIds(rows.map((r) => r.id));
    return {
      data: rows.map((t) => ({
        id: t.id,
        shortId: shortId(t.project.keyPrefix, t.number),
        title: t.title,
        status: t.status,
        priority: t.priority,
        acceptance: t.acceptance,
        dueDate: isoDate(t.dueDate),
        estimatedHours: t.estimatedHours === null ? null : Number(t.estimatedHours),
        overdue: !!t.dueDate && t.dueDate < todayFor(t.project.workspace.timezone),
        blocked: blocked.has(t.id),
        project: { id: t.project.id, name: t.project.name, keyPrefix: t.project.keyPrefix, workspaceId: t.project.workspaceId },
      })),
    };
  }

  // ───────────── input checks ─────────────

  private checkDates(start?: string | null, due?: string | null) {
    if (start && due && due < start) throw Errors.validation({ dueDate: 'must be on or after startDate' });
  }

  private async checkRefs(project: ProjectWithSpace, dto: { phaseId?: string | null; sprintId?: string | null }) {
    if (dto.phaseId) {
      const phase = await this.prisma.phase.findUnique({ where: { id: dto.phaseId } });
      if (!phase || phase.projectId !== project.id) throw Errors.validation({ phaseId: 'must be a phase of this project' });
    }
    if (dto.sprintId) {
      const sprint = await this.prisma.sprint.findUnique({ where: { id: dto.sprintId } });
      if (!sprint || sprint.projectId !== project.id) throw Errors.validation({ sprintId: 'must be a sprint of this project' });
      if (sprint.state === SprintState.completed) throw Errors.validation({ sprintId: 'this sprint is completed; choose a planned or active sprint' });
    }
  }

  private async checkParent(projectId: string, parentId: string) {
    const parent = await this.prisma.task.findUnique({ where: { id: parentId } });
    if (!parent || parent.projectId !== projectId) throw Errors.validation({ parentTaskId: 'must be a task of this project' });
    if (parent.parentTaskId) throw Errors.validation({ parentTaskId: 'subtasks cannot have their own subtasks (one level deep)' });
  }

  private async startStatus(spaceId: string, statusId?: string) {
    if (statusId) {
      const s = await this.prisma.workflowStatus.findUnique({ where: { id: statusId } });
      if (!s || s.spaceId !== spaceId) throw Errors.validation({ statusId: "must be a status of this project's space" });
      if (s.category === StatusCategory.closed) throw Errors.forbidden('A task cannot be created in a closed status.', 'APPROVAL_REQUIRED');
      return s.id;
    }
    const first = await this.prisma.workflowStatus.findFirst({ where: { spaceId, category: StatusCategory.not_started }, orderBy: { position: 'asc' } });
    return first!.id; // every space keeps a Not started status
  }

  private async checkSkills(workspaceId: string, input: RequiredSkillDto[]) {
    const ids = input.map((s) => s.skillId);
    if (unique(ids).length !== ids.length) throw Errors.validation({ requiredSkills: 'each skill may be listed once' });
    if (!ids.length) return [];
    const found = await this.prisma.skill.findMany({ where: { id: { in: ids }, workspaceId }, select: { id: true } });
    const missing = ids.filter((id) => !found.some((f) => f.id === id));
    if (missing.length) throw Errors.validation({ requiredSkills: `not skills of this workspace's catalog: ${missing.join(', ')}` });
    return input.map((s) => ({ skillId: s.skillId, minLevel: s.minLevel }));
  }

  private async checkFieldValues(spaceId: string, input?: Record<string, unknown>) {
    if (!input) return [];
    const ids = Object.keys(input);
    const fields = await this.prisma.customField.findMany({ where: { spaceId, id: { in: ids } } });
    const errors: Record<string, string> = {};
    for (const id of ids) {
      const field = fields.find((f) => f.id === id);
      const problem = field ? checkFieldValue(field, input[id]) : "is not a custom field of this project's space";
      if (problem) errors[`customFields.${id}`] = problem;
    }
    if (Object.keys(errors).length) throw Errors.validation(errors);
    return ids.map((fieldId) => ({ fieldId, value: input[fieldId] }));
  }

  private async writeFieldValues(tx: Tx, taskId: string, values: { fieldId: string; value: unknown }[]) {
    for (const { fieldId, value } of values) {
      if (value === null) await tx.taskFieldValue.deleteMany({ where: { taskId, fieldId } });
      else {
        const v = value as Prisma.InputJsonValue;
        await tx.taskFieldValue.upsert({ where: { taskId_fieldId: { taskId, fieldId } }, create: { taskId, fieldId, value: v }, update: { value: v } });
      }
    }
  }

  /** Turns ?fieldValue= into the JSON value it is stored as (number, boolean or string). */
  private parseFieldFilter(raw: string): Prisma.InputJsonValue {
    if (raw === 'true' || raw === 'false') return raw === 'true';
    if (raw.trim() !== '' && !Number.isNaN(Number(raw)) && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return Number(raw);
    return raw;
  }

  private decodeCursor(cursor: string) {
    const id = Buffer.from(cursor, 'base64url').toString();
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw Errors.validation({ cursor: 'is not valid' });
    return id;
  }

  /** Old and new values of the changed fields, for the activity log (NFR-9). */
  private diff(before: Record<string, any>, after: Record<string, any>) {
    const keys = ['title', 'description', 'priority', 'estimatedHours', 'storyPoints', 'phaseId', 'sprintId', 'parentTaskId', 'startDate', 'dueDate'];
    const norm = (v: unknown) => (v instanceof Date ? isoDate(v) : v !== null && typeof v === 'object' ? Number(v) : v);
    const oldValue: Record<string, Prisma.InputJsonValue | null> = {};
    const newValue: Record<string, Prisma.InputJsonValue | null> = {};
    for (const k of keys) {
      const a = norm(before[k]);
      const b = norm(after[k]);
      if (a !== b) {
        oldValue[k] = a as Prisma.InputJsonValue | null;
        newValue[k] = b as Prisma.InputJsonValue | null;
      }
    }
    return { oldValue, newValue };
  }
}

/** True if adding "task depends on dependsOn" would close a loop (dependsOn already waits for task). */
export function wouldCreateLoop(edges: { taskId: string; dependsOnTaskId: string }[], taskId: string, dependsOnTaskId: string) {
  const next = new Map<string, string[]>();
  for (const e of edges) next.set(e.taskId, [...(next.get(e.taskId) ?? []), e.dependsOnTaskId]);
  const seen = new Set<string>();
  const stack = [dependsOnTaskId];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === taskId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(next.get(id) ?? []));
  }
  return false;
}
