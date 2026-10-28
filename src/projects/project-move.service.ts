import { Injectable } from '@nestjs/common';
import { FieldType, Prisma, SpaceVisibility, WorkspaceRole } from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { Errors } from '../common/app-exception';
import { PrismaService } from '../prisma/prisma.service';
import { MoveProjectDto } from './dto/project.dto';
import { mapFields, mapStatuses } from './move-mapping';
import { ProjectAccessService } from './project-access.service';

type Tx = Prisma.TransactionClient;

/** Thrown inside the transaction to roll back a dry run while keeping its report. */
class DryRunDone {
  constructor(readonly report: unknown) {}
}

/**
 * POST /projects/:id/move (SRS FR-9.2, Admin only). Everything happens in one transaction, so the move either fully
 * succeeds or changes nothing. With "dryRun": true the same work is done and then rolled back, so the report is exact.
 */
@Injectable()
export class ProjectMoveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectAccess: ProjectAccessService,
    private readonly activity: ActivityService,
  ) {}

  async move(projectId: string, actorId: string, dto: MoveProjectDto) {
    const { project } = await this.projectAccess.require(projectId, actorId, 'admin');
    const target = await this.prisma.space.findUnique({ where: { id: dto.spaceId } });
    if (!target || target.workspaceId !== project.workspaceId) {
      throw Errors.conflict('INVALID_PROJECT_MOVE', 'The target space must be a space of the same workspace.');
    }
    if (target.archivedAt) throw Errors.conflict('INVALID_PROJECT_MOVE', `The space "${target.name}" is archived, so projects cannot be moved into it.`);
    if (target.id === project.spaceId) throw Errors.conflict('INVALID_PROJECT_MOVE', 'The project is already in this space.');
    for (const [k, v] of Object.entries(dto.statusMapping ?? {})) {
      if (typeof v !== 'string') throw Errors.validation({ [`statusMapping.${k}`]: 'must be a status id' });
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const report = await this.apply(tx, project.workspaceId, project.id, project.spaceId, target, dto);
        if (dto.dryRun) throw new DryRunDone(report);
        await this.activity.log(
          {
            workspaceId: project.workspaceId, actorId, entityType: 'project', entityId: projectId, action: 'moved',
            oldValue: { spaceId: project.spaceId, spaceName: project.space.name },
            newValue: { spaceId: target.id, spaceName: target.name, ...report.summary },
          },
          tx,
        );
        // TODO (notifications module): notify the Project Manager. NotificationEvent has no "project moved" type yet.
        return report;
      });
    } catch (e) {
      if (e instanceof DryRunDone) return e.report;
      throw e;
    }
  }

  private async apply(tx: Tx, workspaceId: string, projectId: string, fromSpaceId: string, target: { id: string; name: string; visibility: SpaceVisibility }, dto: MoveProjectDto) {
    const [fromSpace, sourceStatuses, targetStatuses, sourceFields, targetFields] = await Promise.all([
      tx.space.findUniqueOrThrow({ where: { id: fromSpaceId }, select: { id: true, name: true } }),
      tx.workflowStatus.findMany({ where: { spaceId: fromSpaceId }, orderBy: { position: 'asc' } }),
      tx.workflowStatus.findMany({ where: { spaceId: target.id }, orderBy: { position: 'asc' } }),
      tx.customField.findMany({ where: { spaceId: fromSpaceId } }),
      tx.customField.findMany({ where: { spaceId: target.id } }),
    ]);

    // 2. Task statuses
    const { map, errors } = mapStatuses(sourceStatuses, targetStatuses, dto.statusMapping);
    if (Object.keys(errors).length) throw Errors.validation(errors, 'The status mapping is not valid.');
    const used = await tx.task.groupBy({ by: ['statusId'], where: { projectId }, _count: { _all: true } });
    const statusChanges = used.map((u) => {
      const from = sourceStatuses.find((s) => s.id === u.statusId)!;
      const to = map.get(u.statusId)!;
      return { from: { id: from.id, name: from.name }, to: { id: to.id, name: to.name }, tasks: u._count._all };
    });
    for (const c of statusChanges) await tx.task.updateMany({ where: { projectId, statusId: c.from.id }, data: { statusId: c.to.id } });

    // 3. Custom field values
    const matches = mapFields(sourceFields, targetFields);
    const inProject = { task: { projectId } };
    const fieldChanges = [];
    for (const field of sourceFields) {
      const m = matches.get(field.id)!;
      const values = await tx.taskFieldValue.count({ where: { fieldId: field.id, ...inProject } });
      if (!values) continue;
      let kept = 0;
      if (m.target && field.fieldType !== FieldType.dropdown) {
        kept = (await tx.taskFieldValue.updateMany({ where: { fieldId: field.id, ...inProject }, data: { fieldId: m.target.id } })).count;
      } else if (m.target) {
        for (const [oldId, newId] of m.options) {
          const r = await tx.taskFieldValue.updateMany({ where: { fieldId: field.id, value: { equals: oldId }, ...inProject }, data: { fieldId: m.target.id, value: newId } });
          kept += r.count;
        }
      }
      const removed = (await tx.taskFieldValue.deleteMany({ where: { fieldId: field.id, ...inProject } })).count;
      fieldChanges.push({ field: { id: field.id, name: field.name, fieldType: field.fieldType }, mappedTo: m.target ? { id: m.target.id, name: m.target.name } : null, keptValues: kept, removedValues: removed });
    }

    // 4. People: members must see the target space (all of them if it is Private; Guests always).
    const allMembers = await tx.projectMember.findMany({ where: { projectId }, include: { user: { select: { id: true, fullName: true } } } });
    const guests = new Set(
      (await tx.workspaceMember.findMany({ where: { workspaceId, role: WorkspaceRole.guest, userId: { in: allMembers.map((m) => m.userId) } }, select: { userId: true } })).map((g) => g.userId),
    );
    const members = target.visibility === SpaceVisibility.private ? allMembers : allMembers.filter((m) => guests.has(m.userId));
    const existing = await tx.spaceMember.findMany({ where: { spaceId: target.id, userId: { in: members.map((m) => m.userId) } }, select: { userId: true } });
    const toAdd = members.filter((m) => !existing.some((e) => e.userId === m.userId));
    if (toAdd.length) {
      await tx.spaceMember.createMany({ data: toAdd.map((m) => ({ spaceId: target.id, userId: m.userId, addedViaTeamId: m.addedViaTeamId })), skipDuplicates: true });
    }

    await tx.project.update({ where: { id: projectId }, data: { spaceId: target.id } });

    const summary = {
      tasksMoved: statusChanges.reduce((s, c) => s + c.tasks, 0),
      tasksChangingStatusName: statusChanges.filter((c) => c.from.name !== c.to.name).reduce((s, c) => s + c.tasks, 0),
      fieldValuesKept: fieldChanges.reduce((s, f) => s + f.keptValues, 0),
      fieldValuesRemoved: fieldChanges.reduce((s, f) => s + f.removedValues, 0),
      membersAddedToSpace: toAdd.length,
    };
    return {
      dryRun: !!dto.dryRun,
      from: fromSpace,
      to: { id: target.id, name: target.name },
      summary,
      statusChanges,
      customFields: fieldChanges,
      membersAddedToSpace: toAdd.map((m) => ({ id: m.user.id, fullName: m.user.fullName })),
    };
  }
}
