import { ChannelType, Prisma, ProjectRole } from '@prisma/client';

type Tx = Prisma.TransactionClient;

/** Creates the project's group channel (SRS FR-5.2) and fills it with the project's members. */
export async function createProjectChannel(tx: Tx, workspaceId: string, projectId: string) {
  await tx.channel.create({ data: { workspaceId, projectId, type: ChannelType.project } });
  await syncProjectChannels(tx, [projectId]);
}

/**
 * Makes each project channel's members match the project's members. Guests are left out:
 * they cannot see messages (API Design, access rules).
 */
export async function syncProjectChannels(tx: Tx, projectIds: Iterable<string>) {
  for (const projectId of new Set(projectIds)) {
    const channel = await tx.channel.findFirst({ where: { projectId, type: ChannelType.project }, select: { id: true } });
    if (!channel) continue;
    const members = await tx.projectMember.findMany({ where: { projectId, role: { not: ProjectRole.guest } }, select: { userId: true } });
    const ids = members.map((m) => m.userId);
    await tx.channelMember.deleteMany({ where: { channelId: channel.id, userId: { notIn: ids } } });
    if (ids.length) await tx.channelMember.createMany({ data: ids.map((userId) => ({ channelId: channel.id, userId })), skipDuplicates: true });
  }
}
