import { Injectable } from '@nestjs/common';
import { CustomField, FieldType, Prisma, SprintState, StatusCategory } from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { Errors } from '../common/app-exception';
import { pageArgs, toPage } from '../common/paging';
import { dateOnly, isoDate, shortId, unique } from '../common/utils';
import { CustomRulesService } from '../automations/custom-rules.service';
import { AttachmentsService } from '../files/attachments.service';
import { DeadlinesService } from '../jobs/deadlines.service';
import { NotificationsService } from '../notifications/notifications.service';
import { afterCommit, PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService, ProjectWithSpace } from '../projects/project-access.service';
import { overdueWhere, todayFor } from '../projects/project-stats';
import { checkFieldValue } from '../spaces/custom-field-values';
import { wouldCreateLoop } from './dependencies';
import { AddDependencyDto, CreateTaskDto, MyTasksQuery, RequiredSkillDto, TaskListQuery, UpdateTaskDto } from './dto/task.dto';
import { TaskAccessService } from './task-access.service';
import { listInclude, TaskViewService } from './task-view.service';
import { firstOf } from './task-workflow';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_ID = /^([A-Za-z][A-Za-z0-9]{1,4})-(\d{1,9})$/;

/** Tasks (SRS 3.2): created and edited by the PM or Admin; status and assignee change through action endpoints. */
@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
    private readonly taskAccess: TaskAccessService,
    private readonly view: TaskViewService,
    private readonly notifications: NotificationsService,
    private readonly deadlines: DeadlinesService,
    private readonly attachments: AttachmentsService,
    private readonly activity: ActivityService,
    private readonly rules: CustomRulesService,
  ) {}

  /** GET /projects/:id/tasks — filters, sorting and cursor paging. */
  async list(projectId: string, userId: string, q: TaskListQuery) {
    const { project } = await this.projectAccess.require(projectId, userId, 'read');
    const today = todayFor(project.workspace.timezone);
    const and: Prisma.TaskWhereInput[] = [{ projectId }];
    if (q.status) and.push(UUID.test(q.status) ? { statusId: q.status } : { status: { category: q.status as StatusCategory } });
    if (q.assigneeId) and.push({ assigneeId: q.assigneeId === 'me' ? userId : q.assigneeId === 'none' ? null : q.assigneeId });
    if (q.phaseId) and.push({ phaseId: q.phaseId === 'none' ? null : q.phaseId });
    if (q.sprintId) and.push({ sprintId: UUID.test(q.sprintId) ? q.sprintId : null });
    if (q.parentTaskId) and.push({ parentTaskId: q.parentTaskId === 'none' ? null : q.parentTaskId });
    if (q.priority) and.push({ priority: q.priority });
    if (q.overdue) and.push(overdueWhere(today));
    if (q.q?.trim()) {
      const text = q.q.trim();
      const key = SHORT_ID.exec(text);
      const or: Prisma.TaskWhereInput[] = [
        { title: { contains: text, mode: 'insensitive' } },
        { description: { contains: text, mode: 'insensitive' } },
      ];
      if (key && key[1].toUpperCase() === project.keyPrefix) or.push({ number: Number(key[2]) });
      and.push({ OR: or });
    }
    if (q.cf && Object.keys(q.cf).length) and.push(...(await this.customFieldFilters(project.spaceId, q.cf)));

    const sort = q.sort ?? 'number';
    const field = sort.replace('-', '') as 'dueDate' | 'priority' | 'number' | 'createdAt' | 'updatedAt';
    const dir: Prisma.SortOrder = sort.startsWith('-') ? 'desc' : 'asc';
    const orderBy: Prisma.TaskOrderByWithRelationInput[] = [
      field === 'dueDate' ? { dueDate: { sort: dir, nulls: 'last' } } : { [field]: dir },
      { number: 'asc' },
    ];
    const rows = await this.prisma.task.findMany({ where: { AND: and }, include: listInclude, orderBy, ...pageArgs(q) });
    const flags = await this.view.flags(rows.map((r) => r.id));
    return toPage(rows, q, (r) => this.view.listItem(r, flags, today));
  }

  /** POST /projects/:id/tasks (PM, Admin). */
  async create(projectId: string, actorId: string, dto: CreateTaskDto) {
    const { project } = await this.projectAccess.require(projectId, actorId, 'manage');
    this.projectAccess.assertWritable(project);

    let parent = null;
    if (dto.parentTaskId) {
      parent = await this.prisma.task.findUnique({ where: { id: dto.parentTaskId } });
      if (!parent || parent.projectId !== projectId) throw Errors.validation({ parentTaskId: 'must be a task of the same project' });
      if (parent.parentTaskId) throw Errors.validation({ parentTaskId: 'subtasks cannot have their own subtasks' });
    }
    const phaseId = dto.phaseId ?? parent?.phaseId ?? null;
    const sprintId = dto.sprintId ?? parent?.sprintId ?? null;
    await this.checkPhase(projectId, phaseId);
    await this.checkSprint(projectId, sprintId);
    this.checkDates(dto.startDate ?? null, dto.dueDate ?? null);

    const statuses = await this.prisma.workflowStatus.findMany({ where: { spaceId: project.spaceId }, orderBy: { position: 'asc' } });
    const status = dto.statusId ? statuses.find((s) => s.id === dto.statusId) : firstOf(statuses, StatusCategory.not_started);
    if (!status) throw Errors.validation({ statusId: "must be a status of the project's space" });
    if (status.category === StatusCategory.closed) throw Errors.validation({ statusId: 'a task cannot start in a closed status' });

    const skills = await this.checkSkills(project.workspaceId, dto.requiredSkills ?? []);
    const values = await this.checkCustomFields(project.spaceId, dto.customFields ?? {});

    const task = await this.prisma.tx(async (tx) => {
      // Locks the project row, so two tasks created at once never get the same number.
      const { nextTaskNumber } = await tx.project.update({ where: { id: projectId }, data: { nextTaskNumber: { increment: 1 } }, select: { nextTaskNumber: true } });
      const created = await tx.task.create({
        data: {
          workspaceId: project.workspaceId,
          projectId,
          number: nextTaskNumber - 1,
          title: dto.title.trim(),
          description: dto.description?.trim() || null,
          phaseId,
          sprintId,
          parentTaskId: parent?.id ?? null,
          statusId: status.id,
          priority: dto.priority ?? undefined,
          estimatedHours: dto.estimatedHours ?? null,
          storyPoints: dto.storyPoints ?? null,
          startDate: dto.startDate ? dateOnly(dto.startDate) : null,
          dueDate: dto.dueDate ? dateOnly(dto.dueDate) : null,
          createdById: actorId,
        },
      });
      if (skills.length) await tx.taskSkill.createMany({ data: skills.map((s) => ({ taskId: created.id, ...s })) });
      const set = values.filter((v) => v.value !== null);
      if (set.length) await tx.taskFieldValue.createMany({ data: set.map((v) => ({ taskId: created.id, fieldId: v.fieldId, value: v.value as Prisma.InputJsonValue })) });
      await this.activity.log(
        {
          workspaceId: project.workspaceId, actorId, entityType: 'task', entityId: created.id, action: 'created',
          newValue: { shortId: shortId(project.keyPrefix, created.number), title: created.title, dueDate: dto.dueDate ?? null },
        },
        tx,
      );
      await this.rules.run(tx, 'task.created', { projectId, taskId: created.id });
      if (created.dueDate) afterCommit(() => this.deadlines.scheduleTask(created.id));
      return created;
    });
    return this.detailFor(task.id, actorId);
  }

  /** GET /tasks/:id */
  async get(taskId: string, userId: string) {
    await this.taskAccess.require(taskId, userId, 'read');
    return this.detailFor(taskId, userId);
  }

  /** GET /tasks/by-key/MBA-42 (Members, Admin). */
  async byKey(key: string, userId: string, workspaceId?: string) {
    const m = SHORT_ID.exec(key.trim());
    if (!m) throw Errors.notFound('Task');
    const projects = await this.prisma.project.findMany({
      where: { keyPrefix: m[1].toUpperCase(), workspace: { members: { some: { userId } } }, ...(workspaceId ? { workspaceId } : {}) },
      select: { id: true },
    });
    if (!projects.length) throw Errors.notFound('Task');
    if (projects.length > 1) throw Errors.validation({ workspaceId: 'required: several of your workspaces use this key prefix' });
    const task = await this.prisma.task.findUnique({ where: { projectId_number: { projectId: projects[0].id, number: Number(m[2]) } }, select: { id: true } });
    if (!task) throw Errors.notFound('Task');
    await this.taskAccess.require(task.id, userId, 'member');
    return this.detailFor(task.id, userId);
  }

  /** PATCH /tasks/:id (PM, Admin). */
  async update(taskId: string, actorId: string, dto: UpdateTaskDto) {
    const access = await this.taskAccess.require(taskId, actorId, 'manage');
    this.projectAccess.assertWritable(access.project);
    const { task, project } = access;
    if (dto.phaseId !== undefined) await this.checkPhase(task.projectId, dto.phaseId);
    if (dto.sprintId !== undefined) await this.checkSprint(task.projectId, dto.sprintId);
    const start = dto.startDate !== undefined ? dto.startDate : isoDate(task.startDate);
    const due = dto.dueDate !== undefined ? dto.dueDate : isoDate(task.dueDate);
    if (dto.startDate !== undefined || dto.dueDate !== undefined) this.checkDates(start, due);
    const values = dto.customFields ? await this.checkCustomFields(project.spaceId, dto.customFields) : [];

    const data: Prisma.TaskUncheckedUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title.trim();
    if (dto.description !== undefined) data.description = dto.description?.trim() || null;
    if (dto.phaseId !== undefined) data.phaseId = dto.phaseId;
    if (dto.sprintId !== undefined) data.sprintId = dto.sprintId;
    if (dto.priority !== undefined) data.priority = dto.priority;
    if (dto.estimatedHours !== undefined) data.estimatedHours = dto.estimatedHours;
    if (dto.storyPoints !== undefined) data.storyPoints = dto.storyPoints;
    if (dto.startDate !== undefined) data.startDate = dto.startDate ? dateOnly(dto.startDate) : null;
    const dueChanged = dto.dueDate !== undefined && dto.dueDate !== isoDate(task.dueDate);
    if (dueChanged) {
      data.dueDate = dto.dueDate ? dateOnly(dto.dueDate) : null;
      data.overdueNotifiedAt = null; // the overdue alert may fire again for the new date
    }

    await this.prisma.tx(async (tx) => {
      await tx.task.update({ where: { id: taskId }, data });
      if (dueChanged) await tx.taskReminder.deleteMany({ where: { taskId } }); // reminders restart for the new date
      for (const v of values) {
        if (v.value === null) await tx.taskFieldValue.deleteMany({ where: { taskId, fieldId: v.fieldId } });
        else {
          await tx.taskFieldValue.upsert({
            where: { taskId_fieldId: { taskId, fieldId: v.fieldId } },
            create: { taskId, fieldId: v.fieldId, value: v.value as Prisma.InputJsonValue },
            update: { value: v.value as Prisma.InputJsonValue },
          });
        }
      }
      const changed = Object.keys(dto).filter((k) => k !== 'customFields' && (dto as Record<string, unknown>)[k] !== undefined);
      const before = Object.fromEntries(changed.map((k) => [k, this.plain((task as Record<string, unknown>)[k])]));
      const after = Object.fromEntries(changed.map((k) => [k, (dto as Record<string, unknown>)[k] ?? null]));
      await this.activity.log(
        {
          workspaceId: task.workspaceId, actorId, entityType: 'task', entityId: taskId, action: dueChanged ? 'deadline_changed' : 'updated',
          oldValue: before as Prisma.InputJsonValue, newValue: { ...after, ...(values.length ? { customFields: values.map((v) => v.fieldId) } : {}) } as Prisma.InputJsonValue,
        },
        tx,
      );
      if (dueChanged) {
        await this.notifications.taskEvent(tx, {
          kind: 'due_date_changed', workspaceId: task.workspaceId, actorId, recipientIds: [task.assigneeId], dueDate: dto.dueDate ?? null,
          task: { id: task.id, shortId: shortId(project.keyPrefix, task.number), title: task.title },
        });
        // New reminders and overdue alert for the new date; the old date's jobs are removed.
        afterCommit(() => this.deadlines.scheduleTask(taskId, isoDate(task.dueDate)));
      }
    });
    return this.detailFor(taskId, actorId);
  }

  /** DELETE /tasks/:id — also deletes its subtasks. */
  async remove(taskId: string, actorId: string) {
    const { task, project } = await this.taskAccess.require(taskId, actorId, 'manage');
    this.projectAccess.assertWritable(project);
    const subtasks = await this.prisma.task.count({ where: { parentTaskId: taskId } });
    // Rows go with the task (ON DELETE CASCADE); the stored files are removed after the commit.
    const files = await this.prisma.attachment.findMany({ where: { task: { OR: [{ id: taskId }, { parentTaskId: taskId }] } }, select: { storageKey: true } });
    await this.prisma.tx(async (tx) => {
      afterCommit(() => this.deadlines.cancelTask(taskId, isoDate(task.dueDate), task.workspaceId));
      afterCommit(() => this.attachments.removeFiles(files.map((f) => f.storageKey)));
      await tx.task.delete({ where: { id: taskId } });
      await this.activity.log(
        { workspaceId: task.workspaceId, actorId, entityType: 'task', entityId: taskId, action: 'deleted', oldValue: { shortId: shortId(project.keyPrefix, task.number), title: task.title, subtasks } },
        tx,
      );
    });
  }

  /** PUT /tasks/:id/skills — replaces the required skills. */
  async setSkills(taskId: string, actorId: string, items: RequiredSkillDto[]) {
    const { task, project } = await this.taskAccess.require(taskId, actorId, 'manage');
    this.projectAccess.assertWritable(project);
    const skills = await this.checkSkills(project.workspaceId, items);
    await this.prisma.$transaction(async (tx) => {
      await tx.taskSkill.deleteMany({ where: { taskId } });
      if (skills.length) await tx.taskSkill.createMany({ data: skills.map((s) => ({ taskId, ...s })) });
      await this.activity.log({ workspaceId: task.workspaceId, actorId, entityType: 'task', entityId: taskId, action: 'skills_changed', newValue: skills }, tx);
    });
    const rows = await this.prisma.taskSkill.findMany({ where: { taskId }, include: { skill: { select: { name: true, category: true } } } });
    return { data: rows.map((r) => ({ skillId: r.skillId, name: r.skill.name, category: r.skill.category, minLevel: r.minLevel })) };
  }

  /** POST /tasks/:id/dependencies — refused with DEPENDENCY_LOOP if it would make a loop. */
  async addDependency(taskId: string, actorId: string, dto: AddDependencyDto) {
    const { task, project } = await this.taskAccess.require(taskId, actorId, 'manage');
    this.projectAccess.assertWritable(project);
    const other = await this.prisma.task.findUnique({ where: { id: dto.dependsOnTaskId }, select: { id: true, projectId: true, number: true } });
    if (!other || other.projectId !== task.projectId) throw Errors.validation({ dependsOnTaskId: 'must be another task of the same project' });
    const edges = await this.prisma.taskDependency.findMany({ where: { task: { projectId: task.projectId } }, select: { taskId: true, dependsOnTaskId: true } });
    if (edges.some((e) => e.taskId === taskId && e.dependsOnTaskId === other.id)) return this.detailFor(taskId, actorId);
    if (wouldCreateLoop(edges, taskId, other.id)) {
      throw Errors.conflict('DEPENDENCY_LOOP', `${shortId(project.keyPrefix, other.number)} already waits for this task, so this dependency would make a loop.`);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.taskDependency.create({ data: { taskId, dependsOnTaskId: other.id } });
      await this.activity.log(
        { workspaceId: task.workspaceId, actorId, entityType: 'task', entityId: taskId, action: 'dependency_added', newValue: { dependsOn: shortId(project.keyPrefix, other.number) } },
        tx,
      );
    });
    return this.detailFor(taskId, actorId);
  }

  async removeDependency(taskId: string, actorId: string, otherTaskId: string) {
    const { task, project } = await this.taskAccess.require(taskId, actorId, 'manage');
    this.projectAccess.assertWritable(project);
    const removed = await this.prisma.taskDependency.deleteMany({ where: { taskId, dependsOnTaskId: otherTaskId } });
    if (!removed.count) throw Errors.notFound('Dependency');
    await this.activity.log({ workspaceId: task.workspaceId, actorId, entityType: 'task', entityId: taskId, action: 'dependency_removed', oldValue: { dependsOnTaskId: otherTaskId } });
  }

  /** GET /me/tasks — my unfinished tasks in every project I still belong to, by due date. */
  async myTasks(userId: string, q: MyTasksQuery) {
    const rows = await this.prisma.task.findMany({
      where: {
        assigneeId: userId,
        completedAt: null,
        project: { archivedAt: null, members: { some: { userId } } },
        workspace: { members: { some: { userId } } },
        ...(q.workspaceId ? { workspaceId: q.workspaceId } : {}),
      },
      include: { ...listInclude, project: { select: { id: true, name: true, keyPrefix: true, workspace: { select: { id: true, timezone: true } } } } },
      orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { priority: 'desc' }],
      take: 200,
    });
    const flags = await this.view.flags(rows.map((r) => r.id));
    return {
      data: rows.map((r) => ({
        ...this.view.listItem(r, flags, todayFor(r.project.workspace.timezone)),
        project: { id: r.project.id, name: r.project.name, keyPrefix: r.project.keyPrefix, workspaceId: r.project.workspace.id },
      })),
    };
  }

  // ───────────── helpers ─────────────

  /** Task details as the given user sees them. */
  async detailFor(taskId: string, userId: string) {
    const access = await this.taskAccess.require(taskId, userId, 'read');
    return this.view.detail(taskId, {
      userId,
      canManage: access.canManage,
      writable: this.isWritable(access.project),
      timezone: access.project.workspace.timezone,
    });
  }

  private isWritable(p: ProjectWithSpace) {
    return !p.archivedAt && !p.space.archivedAt;
  }

  private checkDates(start: string | null, due: string | null) {
    if (start && due && due < start) throw Errors.validation({ dueDate: 'must be on or after startDate' });
  }

  private async checkPhase(projectId: string, phaseId: string | null) {
    if (!phaseId) return;
    const phase = await this.prisma.phase.findUnique({ where: { id: phaseId }, select: { projectId: true } });
    if (!phase || phase.projectId !== projectId) throw Errors.validation({ phaseId: 'must be a phase of the same project' });
  }

  private async checkSprint(projectId: string, sprintId: string | null) {
    if (!sprintId) return;
    const sprint = await this.prisma.sprint.findUnique({ where: { id: sprintId }, select: { projectId: true, state: true } });
    if (!sprint || sprint.projectId !== projectId) throw Errors.validation({ sprintId: 'must be a sprint of the same project' });
    if (sprint.state === SprintState.completed) throw Errors.validation({ sprintId: 'this sprint is completed; choose a planned or active sprint' });
  }

  private async checkSkills(workspaceId: string, items: RequiredSkillDto[]) {
    const ids = items.map((i) => i.skillId);
    if (unique(ids).length !== ids.length) throw Errors.validation({ requiredSkills: 'each skill can be listed only once' });
    if (!ids.length) return [];
    const found = await this.prisma.skill.findMany({ where: { id: { in: ids }, workspaceId }, select: { id: true } });
    const missing = ids.filter((id) => !found.some((f) => f.id === id));
    if (missing.length) throw Errors.validation({ requiredSkills: `not skills of this workspace's catalog: ${missing.join(', ')}` });
    return items.map((i) => ({ skillId: i.skillId, minLevel: i.minLevel }));
  }

  private async checkCustomFields(spaceId: string, input: Record<string, unknown>) {
    const ids = Object.keys(input);
    if (!ids.length) return [];
    const fields = await this.prisma.customField.findMany({ where: { spaceId, id: { in: ids.filter((id) => UUID.test(id)) } } });
    const errors: Record<string, string> = {};
    const out: { fieldId: string; value: unknown }[] = [];
    for (const id of ids) {
      const field = fields.find((f) => f.id === id);
      if (!field) { errors[`customFields.${id}`] = "is not a custom field of this project's space"; continue; }
      const problem = checkFieldValue(field, input[id]);
      if (problem) errors[`customFields.${id}`] = problem;
      else out.push({ fieldId: id, value: input[id] });
    }
    if (Object.keys(errors).length) throw Errors.validation(errors);
    return out;
  }

  /** ?cf[<fieldId>]=value filters. Text matches part of the value; other types match exactly. */
  private async customFieldFilters(spaceId: string, cf: Record<string, string>): Promise<Prisma.TaskWhereInput[]> {
    const fields = await this.prisma.customField.findMany({ where: { spaceId, id: { in: Object.keys(cf).filter((id) => UUID.test(id)) } } });
    return Object.entries(cf).map(([id, raw]) => {
      const field: CustomField | undefined = fields.find((f) => f.id === id);
      if (!field) throw Errors.validation({ [`cf.${id}`]: "is not a custom field of this project's space" });
      const text = String(raw);
      let value: Prisma.InputJsonValue;
      if (field.fieldType === FieldType.text) return { fieldValues: { some: { fieldId: id, value: { string_contains: text } } } };
      if (field.fieldType === FieldType.number) {
        if (!Number.isFinite(Number(text))) throw Errors.validation({ [`cf.${id}`]: 'must be a number' });
        value = Number(text);
      } else if (field.fieldType === FieldType.checkbox) value = text === 'true';
      else value = text;
      if (field.fieldType === FieldType.checkbox && value === false) {
        // An unchecked box is usually stored as "no value", so match both.
        return { NOT: { fieldValues: { some: { fieldId: id, value: { equals: true } } } } };
      }
      return { fieldValues: { some: { fieldId: id, value: { equals: value } } } };
    });
  }

  private plain(v: unknown) {
    if (v instanceof Date) return isoDate(v);
    if (v instanceof Prisma.Decimal) return Number(v);
    return v ?? null;
  }
}
