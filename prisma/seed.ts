// Fills an empty database with the demo data used in the prototype.
// Run with: npm run db:seed   (all demo users get the password below)
import { AcceptanceState, ChannelType, NotificationEvent, PriorityLevel, PrismaClient, ProjectRole, ProjectStatus, SkillLevel, WorkspaceRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const DEMO_PASSWORD = 'Password123!';

const users = [
  { key: 'AA', fullName: 'Abel Assefa', email: 'abel@company.com', jobTitle: 'Organization admin', role: WorkspaceRole.admin },
  { key: 'BM', fullName: 'Blien Moges', email: 'blien@company.com', jobTitle: 'Project Manager', role: WorkspaceRole.member },
  { key: 'DT', fullName: 'Dawit Tesfaye', email: 'dawit@company.com', jobTitle: 'Backend developer', role: WorkspaceRole.member },
  { key: 'MA', fullName: 'Meron Alemu', email: 'meron@company.com', jobTitle: 'Full-stack developer', role: WorkspaceRole.member },
  { key: 'YB', fullName: 'Yonas Bekele', email: 'yonas@company.com', jobTitle: 'Mobile developer', role: WorkspaceRole.member },
  { key: 'SK', fullName: 'Sara Kebede', email: 'sara@company.com', jobTitle: 'QA engineer', role: WorkspaceRole.member },
  { key: 'HG', fullName: 'Hana Girma', email: 'hana@company.com', jobTitle: 'Frontend developer', role: WorkspaceRole.member },
];

const catalog: [string, string][] = [
  ['Node.js', 'Backend'], ['PostgreSQL', 'Backend'], ['Redis', 'Backend'], ['Background jobs', 'Backend'],
  ['Payments', 'Backend'], ['API design', 'Backend'], ['React', 'Frontend'], ['UI design', 'Design'],
  ['React Native', 'Mobile'], ['Firebase', 'Mobile'], ['Security', 'Security'], ['Test automation', 'Testing'],
  ['Android', 'Testing'], ['iOS', 'Testing'], ['Project management', 'Management'], ['Scrum', 'Management'],
];

const L = SkillLevel;
const userSkills: Record<string, [string, SkillLevel, boolean][]> = {
  AA: [['Project management', L.intermediate, true]],
  BM: [['Project management', L.expert, true], ['Scrum', L.expert, true]],
  DT: [['Node.js', L.expert, true], ['PostgreSQL', L.expert, true], ['Redis', L.expert, false], ['Payments', L.intermediate, true]],
  MA: [['Node.js', L.expert, true], ['React', L.expert, true], ['Redis', L.intermediate, false], ['Background jobs', L.intermediate, false], ['API design', L.expert, true]],
  YB: [['React Native', L.expert, true], ['Firebase', L.intermediate, true], ['Security', L.beginner, false]],
  SK: [['Test automation', L.expert, true], ['Android', L.intermediate, true], ['iOS', L.intermediate, false]],
  HG: [['React', L.expert, true], ['UI design', L.intermediate, true], ['Node.js', L.beginner, false], ['React Native', L.intermediate, false]],
};

async function main() {
  if (await prisma.workspace.findUnique({ where: { slug: 'acme-software' } })) {
    console.log('Demo data already exists. Nothing to do.');
    return;
  }
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
  const ids: Record<string, string> = {};
  for (const u of users) {
    const created = await prisma.user.create({ data: { email: u.email, passwordHash, fullName: u.fullName, jobTitle: u.jobTitle } });
    ids[u.key] = created.id;
  }

  const workspace = await prisma.workspace.create({ data: { name: 'Acme Software', slug: 'acme-software', timezone: 'Africa/Addis_Ababa', createdById: ids.AA } });

  for (const u of users) {
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: ids[u.key], role: u.role, canManageProjects: u.key === 'AA' || u.key === 'BM', invitedById: u.key === 'AA' ? null : ids.AA },
    });
    await prisma.notificationPreference.createMany({
      data: Object.values(NotificationEvent).map((eventType) => ({
        userId: ids[u.key], workspaceId: workspace.id, eventType, email: true,
        sms: eventType === NotificationEvent.overdue || eventType === NotificationEvent.critical, push: false,
      })),
    });
  }

  const skillIds: Record<string, string> = {};
  for (const [name, category] of catalog) {
    const s = await prisma.skill.create({ data: { workspaceId: workspace.id, name, category } });
    skillIds[name] = s.id;
  }
  for (const [key, list] of Object.entries(userSkills)) {
    for (const [name, level, verified] of list) {
      await prisma.userSkill.create({
        data: { userId: ids[key], skillId: skillIds[name], level, verifiedById: verified ? ids.BM : null, verifiedAt: verified ? new Date() : null },
      });
    }
  }

  // Spaces with their task workflows (tasks are added once those endpoints exist).
  const mobile = await prisma.space.create({ data: { workspaceId: workspace.id, name: 'Mobile apps', description: 'Customer-facing mobile products', visibility: 'open' } });
  const web = await prisma.space.create({ data: { workspaceId: workspace.id, name: 'Web', description: 'Web portals and internal tools', visibility: 'private' } });
  const workflow = (spaceId: string, withTesting: boolean) => {
    const names: [string, 'not_started' | 'active' | 'review' | 'closed'][] = [['To do', 'not_started'], ['In progress', 'active']];
    if (withTesting) names.push(['Testing', 'active']);
    names.push(['In review', 'review'], ['Done', 'closed']);
    const colors: Record<string, string> = { 'To do': '#9CA3AF', 'In progress': '#3B82F6', Testing: '#8B5CF6', 'In review': '#F59E0B', Done: '#10B981' };
    return names.map(([name, category], position) => ({ spaceId, name, category, position, color: colors[name] }));
  };
  await prisma.workflowStatus.createMany({ data: [...workflow(mobile.id, true), ...workflow(web.id, false)] });
  await prisma.spaceMember.createMany({ data: ['AA', 'BM', 'DT', 'MA', 'YB', 'SK', 'HG'].map((k) => ({ spaceId: mobile.id, userId: ids[k] })) });
  await prisma.spaceMember.createMany({ data: ['AA', 'BM', 'MA', 'HG'].map((k) => ({ spaceId: web.id, userId: ids[k] })) });

  // Teams
  const teams: [string, string[]][] = [['Backend team', ['DT', 'MA']], ['Mobile team', ['YB', 'HG']], ['QA team', ['SK']]];
  const teamIds: Record<string, string> = {};
  for (const [name, members] of teams) {
    const team = await prisma.team.create({ data: { workspaceId: workspace.id, name } });
    teamIds[name] = team.id;
    await prisma.teamMember.createMany({ data: members.map((k) => ({ teamId: team.id, userId: ids[k] })) });
  }

  // Projects (dates are relative to today, so the demo always has current and upcoming work).
  const day = (offset: number) => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + offset);
    return d;
  };
  const projects = [
    {
      name: 'Mobile Banking App', keyPrefix: 'MBA', spaceId: mobile.id, status: ProjectStatus.active, start: -30, end: 60,
      description: 'Customer mobile banking app for Android and iOS.',
      teams: ['Backend team', 'Mobile team', 'QA team'],
      phases: [['Design', -10], ['Backend API', 20], ['Mobile app', 40], ['Testing and release', 58]] as [string, number][],
    },
    {
      name: 'Customer Portal', keyPrefix: 'CPO', spaceId: web.id, status: ProjectStatus.planning, start: 7, end: 97,
      description: 'Self-service web portal for account holders.',
      direct: ['MA', 'HG'],
      phases: [['Requirements', 21], ['Build', 70], ['Launch', 95]] as [string, number][],
    },
  ];
  const projectIds: Record<string, string> = {};
  for (const p of projects) {
    const project = await prisma.project.create({
      data: {
        workspaceId: workspace.id, spaceId: p.spaceId, name: p.name, keyPrefix: p.keyPrefix, description: p.description,
        status: p.status, startDate: day(p.start), endDate: day(p.end), createdById: ids.BM,
      },
    });
    projectIds[p.keyPrefix] = project.id;
    await prisma.projectMember.create({ data: { projectId: project.id, userId: ids.BM, role: ProjectRole.project_manager } });
    for (const teamName of p.teams ?? []) {
      const teamId = teamIds[teamName];
      await prisma.projectTeam.create({ data: { projectId: project.id, teamId } });
      const members = teams.find(([n]) => n === teamName)![1];
      await prisma.projectMember.createMany({
        data: members.map((k) => ({ projectId: project.id, userId: ids[k], role: ProjectRole.team_member, addedViaTeamId: teamId })),
        skipDuplicates: true,
      });
    }
    if (p.direct) {
      await prisma.projectMember.createMany({ data: p.direct.map((k) => ({ projectId: project.id, userId: ids[k], role: ProjectRole.team_member })), skipDuplicates: true });
    }
    await prisma.phase.createMany({ data: p.phases.map(([name, due], position) => ({ projectId: project.id, name, position, dueDate: day(due) })) });
    const channel = await prisma.channel.create({ data: { workspaceId: workspace.id, projectId: project.id, type: ChannelType.project } });
    const members = await prisma.projectMember.findMany({ where: { projectId: project.id }, select: { userId: true } });
    await prisma.channelMember.createMany({ data: members.map((m) => ({ channelId: channel.id, userId: m.userId })) });
  }

  // Tasks from the prototype: [key, project, phase, title, required skills, hours, points, priority, start, due, status, assignee, extras]
  type Seed = [string, string, string, string, [string, number][], number, number, PriorityLevel, number, number, string, string, { parent?: string; dependsOn?: string; desc?: string }?];
  const H = PriorityLevel.high, M = PriorityLevel.medium;
  const seedTasks: Seed[] = [
    ['t1', 'MBA', 'Backend API', 'User registration API', [['Node.js', 2], ['PostgreSQL', 2]], 16, 5, H, -12, -3, 'Done', 'DT', { desc: 'Sign-up endpoint with phone verification.' }],
    ['t2', 'MBA', 'Backend API', 'Integrate payment gateway API', [['Node.js', 2], ['Payments', 2]], 24, 8, H, 0, 7, 'In progress', 'DT', { desc: 'Connect the transfer service to the payment gateway sandbox, then production.' }],
    ['t3', 'MBA', 'Backend API', 'Write API docs for transfers', [['API design', 2]], 8, 3, M, -6, -1, 'In progress', 'MA', { desc: 'Document the transfer endpoints for the mobile team.' }],
    ['t4', 'MBA', 'Mobile app', 'Push notification service', [['React Native', 2], ['Firebase', 2]], 16, 5, M, 4, 10, 'In progress', 'YB', { desc: 'Send transaction alerts to the phone.' }],
    ['t5', 'MBA', 'Mobile app', 'Biometric login flow', [['React Native', 3], ['Security', 2]], 20, 8, H, 5, 15, 'In progress', 'YB', { desc: 'Fingerprint and face login after the first PIN login.' }],
    ['t6', 'MBA', 'Testing and release', 'Login regression test suite', [['Test automation', 2]], 12, 5, M, 8, 18, 'To do', 'SK', { dependsOn: 't5', desc: 'Automated tests for every login path.' }],
    ['t7', 'MBA', 'Mobile app', 'Account balance widget', [['React', 2]], 10, 3, M, 2, 11, 'In review', 'HG', { desc: 'Home-screen card showing balances.' }],
    ['t8', 'MBA', 'Mobile app', 'Transaction history screen', [['React Native', 2], ['UI design', 1]], 12, 5, M, 12, 20, 'To do', '', { desc: 'List and filter past transactions.' }],
    ['t9', 'MBA', 'Backend API', 'Overdue alert scheduler', [['Node.js', 2], ['Redis', 2], ['Background jobs', 1]], 16, 8, H, 10, 25, 'To do', '', { desc: 'Background job that schedules reminders and overdue alerts.' }],
    ['t10', 'MBA', 'Backend API', 'Handle payment webhooks', [['Node.js', 2], ['Payments', 1]], 6, 2, H, 6, 12, 'To do', 'DT', { parent: 't2', desc: 'Process success and failure callbacks from the gateway.' }],
    ['t12', 'MBA', 'Mobile app', 'Login screen UI', [['React Native', 2], ['UI design', 1]], 10, 3, M, -2, 4, 'Done', 'HG', { desc: 'Phone number and PIN entry screens.' }],
    ['t11', 'CPO', 'Requirements', 'Portal wireframes', [['UI design', 2]], 12, 5, M, 20, 32, 'To do', 'HG', { desc: 'Wireframes for the main portal pages.' }],
  ];
  const levels = [SkillLevel.beginner, SkillLevel.intermediate, SkillLevel.expert];
  const taskIds: Record<string, string> = {};
  for (const [key, prefix, phaseName, title, skills, hours, points, priority, start, due, statusName, assignee, extra = {}] of seedTasks) {
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectIds[prefix] } });
    const status = await prisma.workflowStatus.findFirstOrThrow({ where: { spaceId: project.spaceId, name: statusName } });
    const phase = await prisma.phase.findFirstOrThrow({ where: { projectId: project.id, name: phaseName } });
    const { nextTaskNumber } = await prisma.project.update({ where: { id: project.id }, data: { nextTaskNumber: { increment: 1 } } });
    const task = await prisma.task.create({
      data: {
        workspaceId: workspace.id, projectId: project.id, number: nextTaskNumber - 1, title, description: extra.desc,
        phaseId: phase.id, parentTaskId: extra.parent ? taskIds[extra.parent] : null, statusId: status.id, priority,
        estimatedHours: hours, storyPoints: points, startDate: day(start), dueDate: day(due),
        assigneeId: assignee ? ids[assignee] : null, acceptance: assignee ? AcceptanceState.accepted : null,
        completedAt: status.category === 'closed' ? day(due) : null, createdById: ids.BM,
      },
    });
    taskIds[key] = task.id;
    await prisma.taskSkill.createMany({ data: skills.map(([name, lvl]) => ({ taskId: task.id, skillId: skillIds[name], minLevel: levels[lvl - 1] })) });
    if (extra.dependsOn) await prisma.taskDependency.create({ data: { taskId: task.id, dependsOnTaskId: taskIds[extra.dependsOn] } });
  }

  console.log('Demo data created.');
  console.log(`Log in with any of these emails and the password ${DEMO_PASSWORD}:`);
  users.forEach((u) => console.log(`  ${u.email.padEnd(20)} ${u.fullName} (${u.role === 'admin' ? 'Workspace Admin' : u.jobTitle})`));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

