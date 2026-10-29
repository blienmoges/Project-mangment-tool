import { Injectable } from '@nestjs/common';
import { Prisma, StatusCategory, WorkflowStatus } from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { Errors } from '../common/app-exception';
import { changedPositions, insertAt } from '../common/ordering';
import { PrismaService } from '../prisma/prisma.service';
import { CreateStatusDto, UpdateStatusDto } from './dto/space.dto';
import { SpaceAccessService } from './space-access.service';
import { allowedRange, CATEGORY_LABEL } from './workflow';

type Tx = Prisma.TransactionClient;

/**
 * A space's task workflow (SRS 3.11, API Design "Workflow rules").
 * Rules kept here: statuses stay in the order Not started → Active → Review → Closed; every space keeps at least
 * one status in each of the four categories (409 WORKFLOW_CATEGORY_REQUIRED); a status's category can only change
 * while no task uses it (409 STATUS_IN_USE), so tasks never become closed or reopened without the approve action.
 */
@Injectable()
export class StatusesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly spaceAccess: SpaceAccessService,
    private readonly activity: ActivityService,
  ) {}

  /** GET /spaces/:id/statuses — in board order, with how many tasks use each. */
  async list(spaceId: string, userId: string) {
    await this.spaceAccess.requireSpace(spaceId, userId);
    const rows = await this.prisma.workflowStatus.findMany({
      where: { spaceId },
      include: { _count: { select: { tasks: true } } },
      orderBy: { position: 'asc' },
    });
    return { data: rows.map(({ _count, ...s }) => ({ ...s, taskCount: _count.tasks })) };
  }

  async create(spaceId: string, actorId: string, dto: CreateStatusDto) {
    const { space } = await this.spaceAccess.requireSpaceAdmin(spaceId, actorId);
    const name = dto.name.trim();
    await this.ensureNameFree(spaceId, name);
    const current = await this.ordered(this.prisma, spaceId);
    const index = this.pickPosition(current, dto.category, dto.position);
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.workflowStatus.create({ data: { spaceId, name, color: dto.color ?? null, category: dto.category, position: index } });
      await this.renumber(tx, insertAt(current, created, index));
      await this.activity.log(
        { workspaceId: space.workspaceId, actorId, entityType: 'workflow_status', entityId: created.id, action: 'created', newValue: { spaceId, name, category: dto.category, position: index } },
        tx,
      );
      return tx.workflowStatus.findUniqueOrThrow({ where: { id: created.id } });
    });
  }

  /** PATCH /statuses/:id — rename, recolor, move (position) or, while unused, change category. */
  async update(statusId: string, actorId: string, dto: UpdateStatusDto) {
    const status = await this.findOrFail(statusId);
    const { space } = await this.spaceAccess.requireSpaceAdmin(status.spaceId, actorId);
    const name = dto.name?.trim();
    if (name && name.toLowerCase() !== status.name.toLowerCase()) await this.ensureNameFree(status.spaceId, name, statusId);

    const current = await this.ordered(this.prisma, status.spaceId);
    const others = current.filter((s) => s.id !== statusId);
    const category = dto.category ?? status.category;
    const categoryChanged = category !== status.category;
    if (categoryChanged) {
      const used = await this.prisma.task.count({ where: { statusId } });
      if (used) {
        throw Errors.conflict('STATUS_IN_USE', `${used} task(s) use "${status.name}". Move them to another status before changing its category, or create a new status instead.`);
      }
      this.ensureNotLastOfCategory(others, status);
    }
    const currentIndex = current.findIndex((s) => s.id === statusId);
    const index = dto.position !== undefined || categoryChanged ? this.pickPosition(others, category, dto.position) : currentIndex;

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.workflowStatus.update({
        where: { id: statusId },
        data: { ...(name ? { name } : {}), ...(dto.color !== undefined ? { color: dto.color } : {}), category },
      });
      await this.renumber(tx, insertAt(others, updated, index));
      await this.activity.log(
        {
          workspaceId: space.workspaceId, actorId, entityType: 'workflow_status', entityId: statusId, action: 'updated',
          oldValue: { name: status.name, color: status.color, category: status.category, position: currentIndex },
          newValue: { name: updated.name, color: updated.color, category, position: index },
        },
        tx,
      );
      return tx.workflowStatus.findUniqueOrThrow({ where: { id: statusId } });
    });
  }

  /** DELETE /statuses/:id?moveTasksTo= — tasks in the status move to another status of the same category. */
  async remove(statusId: string, actorId: string, moveTasksTo?: string) {
    const status = await this.findOrFail(statusId);
    const { space } = await this.spaceAccess.requireSpaceAdmin(status.spaceId, actorId);
    const current = await this.ordered(this.prisma, status.spaceId);
    const others = current.filter((s) => s.id !== statusId);
    this.ensureNotLastOfCategory(others, status);

    const taskCount = await this.prisma.task.count({ where: { statusId } });
    let target: WorkflowStatus | undefined;
    if (taskCount) {
      if (!moveTasksTo) throw Errors.validation({ moveTasksTo: `required: ${taskCount} task(s) use this status` });
      target = others.find((s) => s.id === moveTasksTo);
      if (!target) throw Errors.validation({ moveTasksTo: 'must be another status of the same space' });
      if (target.category !== status.category) {
        throw Errors.validation({ moveTasksTo: `must be a ${CATEGORY_LABEL[status.category]} status, like the one being removed` });
      }
    }

    await this.prisma.$transaction(async (tx) => {
      if (target) await tx.task.updateMany({ where: { statusId }, data: { statusId: target.id } });
      await tx.workflowStatus.delete({ where: { id: statusId } });
      await this.renumber(tx, others);
      await this.activity.log(
        {
          workspaceId: space.workspaceId, actorId, entityType: 'workflow_status', entityId: statusId, action: 'deleted',
          oldValue: { spaceId: status.spaceId, name: status.name, category: status.category },
          newValue: { movedTasks: taskCount, movedTo: target ? { id: target.id, name: target.name } : null },
        },
        tx,
      );
    });
  }

  // ───────────── helpers ─────────────

  private async findOrFail(statusId: string) {
    const status = await this.prisma.workflowStatus.findUnique({ where: { id: statusId } });
    if (!status) throw Errors.notFound('Status');
    return status;
  }

  private ordered(db: Tx | PrismaService, spaceId: string) {
    return db.workflowStatus.findMany({ where: { spaceId }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
  }

  /** Validates a requested position against the category block, or returns the end of the block. */
  private pickPosition(others: WorkflowStatus[], category: StatusCategory, requested?: number) {
    const { min, max } = allowedRange(others, category);
    if (requested === undefined) return max;
    if (requested < min || requested > max) {
      throw Errors.validation({
        position: `must be between ${min} and ${max} for a ${CATEGORY_LABEL[category]} status, so statuses stay in the order Not started, Active, Review, Closed`,
      });
    }
    return requested;
  }

  private ensureNotLastOfCategory(others: WorkflowStatus[], status: WorkflowStatus) {
    if (!others.some((s) => s.category === status.category)) {
      throw Errors.conflict(
        'WORKFLOW_CATEGORY_REQUIRED',
        `"${status.name}" is the only ${CATEGORY_LABEL[status.category]} status. Every workflow needs at least one status in each category.`,
      );
    }
  }

  private async renumber(tx: Tx, ordered: WorkflowStatus[]) {
    for (const c of changedPositions(ordered)) await tx.workflowStatus.update({ where: { id: c.id }, data: { position: c.to } });
  }

  private async ensureNameFree(spaceId: string, name: string, exceptId?: string) {
    const clash = await this.prisma.workflowStatus.findFirst({
      where: { spaceId, name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    });
    if (clash) throw Errors.conflict('ALREADY_EXISTS', 'This space already has a status with this name.');
  }
}
