import { Injectable } from '@nestjs/common';
import { Phase, Prisma } from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { Errors } from '../common/app-exception';
import { changedPositions, insertAt } from '../common/ordering';
import { dateOnly, isoDate } from '../common/utils';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePhaseDto, UpdatePhaseDto } from './dto/project.dto';
import { ProjectAccessService } from './project-access.service';
import { emptyStats, taskStatsBy, todayFor } from './project-stats';

type Tx = Prisma.TransactionClient;

/** Phases (SRS FR-2.1, FR-4.1): ordered milestones of a project, each with an optional due date. */
@Injectable()
export class PhasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
    private readonly activity: ActivityService,
  ) {}

  /** GET /projects/:id/phases — with progress; `overdue` is true when the due date passed with tasks unfinished. */
  async list(projectId: string, userId: string) {
    const { project } = await this.projectAccess.require(projectId, userId, 'read');
    const today = todayFor(project.workspace.timezone);
    const phases = await this.ordered(this.prisma, projectId);
    const stats = await taskStatsBy(this.prisma, 'phaseId', phases.map((p) => p.id), today);
    return {
      data: phases.map((p) => {
        const s = stats.get(p.id) ?? emptyStats();
        return { ...this.out(p), ...s, overdue: !!p.dueDate && p.dueDate < today && s.doneTasks < s.totalTasks };
      }),
    };
  }

  async create(projectId: string, actorId: string, dto: CreatePhaseDto) {
    const { project } = await this.projectAccess.require(projectId, actorId, 'manage');
    this.projectAccess.assertWritable(project);
    const current = await this.ordered(this.prisma, projectId);
    const index = Math.min(dto.position ?? current.length, current.length);
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.phase.create({
        data: { projectId, name: dto.name.trim(), dueDate: dto.dueDate ? dateOnly(dto.dueDate) : null, position: index },
      });
      await this.renumber(tx, insertAt(current, created, index));
      await this.activity.log(
        { workspaceId: project.workspaceId, actorId, entityType: 'phase', entityId: created.id, action: 'created', newValue: { projectId, name: created.name, dueDate: dto.dueDate ?? null } },
        tx,
      );
      return this.out(await tx.phase.findUniqueOrThrow({ where: { id: created.id } }));
    });
  }

  /** PATCH /phases/:id — rename, change or clear the due date, reorder. */
  async update(phaseId: string, actorId: string, dto: UpdatePhaseDto) {
    const phase = await this.findOrFail(phaseId);
    const { project } = await this.projectAccess.require(phase.projectId, actorId, 'manage');
    this.projectAccess.assertWritable(project);
    const current = await this.ordered(this.prisma, phase.projectId);
    const others = current.filter((p) => p.id !== phaseId);
    const index = dto.position !== undefined ? Math.min(dto.position, others.length) : current.findIndex((p) => p.id === phaseId);
    const dueChanged = dto.dueDate !== undefined && dto.dueDate !== isoDate(phase.dueDate);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.phase.update({
        where: { id: phaseId },
        data: {
          ...(dto.name ? { name: dto.name.trim() } : {}),
          // A new due date means the missed-phase alert may be sent again for it.
          ...(dueChanged ? { dueDate: dto.dueDate ? dateOnly(dto.dueDate) : null, overdueNotifiedAt: null } : {}),
        },
      });
      await this.renumber(tx, insertAt(others, updated, index));
      await this.activity.log(
        {
          workspaceId: project.workspaceId, actorId, entityType: 'phase', entityId: phaseId, action: 'updated',
          oldValue: { name: phase.name, dueDate: isoDate(phase.dueDate), position: phase.position },
          newValue: { name: updated.name, dueDate: isoDate(updated.dueDate), position: index },
        },
        tx,
      );
      return this.out(await tx.phase.findUniqueOrThrow({ where: { id: phaseId } }));
    });
  }

  /** DELETE /phases/:id?moveTasksTo= — tasks move to another phase, or are left without one. */
  async remove(phaseId: string, actorId: string, moveTasksTo?: string) {
    const phase = await this.findOrFail(phaseId);
    const { project } = await this.projectAccess.require(phase.projectId, actorId, 'manage');
    this.projectAccess.assertWritable(project);
    if (moveTasksTo) {
      const target = await this.prisma.phase.findUnique({ where: { id: moveTasksTo } });
      if (!target || target.projectId !== phase.projectId || target.id === phaseId) {
        throw Errors.validation({ moveTasksTo: 'must be another phase of the same project' });
      }
    }
    await this.prisma.$transaction(async (tx) => {
      const moved = moveTasksTo ? await tx.task.updateMany({ where: { phaseId }, data: { phaseId: moveTasksTo } }) : { count: 0 };
      const tasks = await tx.task.count({ where: { phaseId } }); // left without a phase by ON DELETE SET NULL
      await tx.phase.delete({ where: { id: phaseId } });
      await this.renumber(tx, await this.ordered(tx, phase.projectId));
      await this.activity.log(
        {
          workspaceId: project.workspaceId, actorId, entityType: 'phase', entityId: phaseId, action: 'deleted',
          oldValue: { projectId: phase.projectId, name: phase.name }, newValue: { movedTasks: moved.count, tasksWithoutPhase: tasks, moveTasksTo: moveTasksTo ?? null },
        },
        tx,
      );
    });
  }

  // ───────────── helpers ─────────────

  private async findOrFail(phaseId: string) {
    const phase = await this.prisma.phase.findUnique({ where: { id: phaseId } });
    if (!phase) throw Errors.notFound('Phase');
    return phase;
  }

  private ordered(db: Tx | PrismaService, projectId: string) {
    return db.phase.findMany({ where: { projectId }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
  }

  private async renumber(tx: Tx, ordered: Phase[]) {
    for (const c of changedPositions(ordered)) await tx.phase.update({ where: { id: c.id }, data: { position: c.to } });
  }

  private out(p: Phase) {
    const { overdueNotifiedAt, ...rest } = p;
    return { ...rest, dueDate: isoDate(p.dueDate) };
  }
}
