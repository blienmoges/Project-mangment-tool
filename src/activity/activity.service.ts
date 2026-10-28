import { Injectable } from '@nestjs/common';
import { ActorType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface ActivityEntry {
  workspaceId: string;
  actorId?: string | null;
  actorType?: ActorType;
  entityType: string;
  entityId: string;
  action: string;
  oldValue?: Prisma.InputJsonValue;
  newValue?: Prisma.InputJsonValue;
}

/** Writes to the activity log (who changed what, and when). Pass `tx` inside a transaction. */
@Injectable()
export class ActivityService {
  constructor(private readonly prisma: PrismaService) {}

  log(entry: ActivityEntry, tx?: Prisma.TransactionClient) {
    const db = tx ?? this.prisma;
    return db.activityLog.create({
      data: {
        workspaceId: entry.workspaceId,
        actorType: entry.actorType ?? ActorType.user,
        actorId: entry.actorId ?? null,
        entityType: entry.entityType,
        entityId: entry.entityId,
        action: entry.action,
        oldValue: entry.oldValue,
        newValue: entry.newValue,
      },
    });
  }
}

