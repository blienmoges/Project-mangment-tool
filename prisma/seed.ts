// Fills an empty database with the demo data used in the prototype.
// Run with: npm run db:seed   (all demo users get the password below)
import { AcceptanceState, ChannelType, IssueType, PriorityLevel, PrismaClient, ProjectRole, ProjectStatus, SeverityLevel, SkillLevel, WorkspaceRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { defaultPreferenceRows } from '../src/workspaces/notification-defaults';

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
    // Demo phone numbers, so SMS alerts (overdue, Critical issues) show up in the server log in development.
    const phone = `+251 911 000 ${100 + users.indexOf(u) + 1}`;
    const created = await prisma.user.create({ data: { email: u.email, passwordHash, fullName: u.fullName, jobTitle: u.jobTitle, phone } });
    ids[u.key] = created.id;
  }

  const workspace = await prisma.workspace.create({ data: { name: 'Acme Software', slug: 'acme-software', timezone: 'Africa/Addis_Ababa', createdById: ids.AA } });

  for (const u of users) {
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: ids[u.key], role: u.role, canManageProjects: u.key === 'AA' || u.key === 'BM', invitedById: u.key === 'AA' ? null : ids.AA },
    });
    await prisma.notificationPreference.createMany({ data: defaultPreferenceRows(workspace.id, ids[u.key]) });
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

  // Spaces with their task workflows.
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

  // Tasks. Each: [project, phase, title, status, assignee, required skills, hours, points, priority, start, due, extras]
  const H = PriorityLevel.high, M = PriorityLevel.medium, Lo = PriorityLevel.low;
  const I = SkillLevel.intermediate, B = SkillLevel.beginner;
  type Extra = { dependsOn?: number[]; parent?: number; concern?: string; desc?: string };
  type SeedTask = [string, string, string, string, string | null, [string, SkillLevel][], number, number, PriorityLevel, number, number, Extra?];
  const seedTasks: SeedTask[] = [
    ['MBA', 'Design', 'Design login and onboarding screens', 'Done', 'HG', [['UI design', I]], 16, 5, M, -28, -12],
    ['MBA', 'Backend API', 'Set up the API project and database', 'Done', 'DT', [['Node.js', I], ['PostgreSQL', I]], 12, 3, H, -20, -5],
    ['MBA', 'Backend API', 'Account balance and transactions API', 'In progress', 'DT', [['Node.js', I], ['PostgreSQL', I]], 24, 8, H, -4, 6, { dependsOn: [2] }],
    ['MBA', 'Mobile app', 'Push notification service', 'In progress', 'YB', [['Firebase', I], ['Node.js', B]], 16, 5, M, -3, 10],
    ['MBA', 'Backend API', 'Money transfer API', 'To do', 'MA', [['Node.js', I], ['Payments', I]], 32, 13, H, 7, 18, { dependsOn: [3] }],
    ['MBA', 'Mobile app', 'Login screen in React Native', 'In review', 'YB', [['React Native', I]], 10, 3, H, -8, -1],
    ['MBA', 'Mobile app', 'Biometric login', 'To do', 'HG', [['React Native', I], ['Security', I]], 12, 5, M, 10, 25,
      { concern: 'I have not used the biometric APIs before. Could Yonas pair with me for the first day?' }],
    ['MBA', 'Backend API', 'Caching for account summaries', 'To do', null, [['Redis', I], ['Node.js', I]], 8, 3, M, 8, 20,
      { desc: 'Cache balance summaries in Redis for 60 seconds to cut database load.' }],
    ['MBA', 'Backend API', 'Background job for monthly statements', 'To do', null, [['Background jobs', I], ['Node.js', I]], 12, 5, Lo, 15, 30],
    ['MBA', 'Testing and release', 'Automated tests for login', 'To do', 'SK', [['Test automation', I], ['Android', I]], 10, 3, M, 2, 12, { dependsOn: [6] }],
    ['MBA', 'Mobile app', 'Research the biometric APIs', 'To do', null, [], 3, 1, Lo, 8, 11, { parent: 7 }],
    ['CPO', 'Requirements', 'Gather portal requirements with customer support', 'To do', 'MA', [['API design', I]], 8, 3, M, 7, 18],
    ['CPO', 'Build', 'Portal page layout and navigation', 'To do', 'HG', [['React', I], ['UI design', I]], 14, 5, M, 22, 40],
  ];
  const created: { id: string; projectId: string }[] = [];
  for (const [prefix, phaseName, title, statusName, who, skills, hours, points, priority, start, due, extra = {}] of seedTasks) {
    const project = await prisma.project.findFirstOrThrow({ where: { workspaceId: workspace.id, keyPrefix: prefix } });
    const phase = await prisma.phase.findFirstOrThrow({ where: { projectId: project.id, name: phaseName } });
    const status = await prisma.workflowStatus.findFirstOrThrow({ where: { spaceId: project.spaceId, name: statusName } });
    const { nextTaskNumber } = await prisma.project.update({ where: { id: project.id }, data: { nextTaskNumber: { increment: 1 } } });
    const task = await prisma.task.create({
      data: {
        workspaceId: workspace.id, projectId: project.id, number: nextTaskNumber - 1, title, description: extra.desc,
        phaseId: phase.id, parentTaskId: extra.parent ? created[extra.parent - 1].id : null, statusId: status.id, priority,
        estimatedHours: hours, storyPoints: points, startDate: day(start), dueDate: day(due), createdById: ids.BM,
        assigneeId: who ? ids[who] : null,
        acceptance: !who ? null : extra.concern ? AcceptanceState.concern : statusName === 'To do' ? AcceptanceState.pending : AcceptanceState.accepted,
        concernNote: extra.concern ?? null,
        completedAt: status.category === 'closed' ? day(due) : null,
      },
    });
    created.push({ id: task.id, projectId: project.id });
    if (skills.length) await prisma.taskSkill.createMany({ data: skills.map(([name, minLevel]) => ({ taskId: task.id, skillId: skillIds[name], minLevel })) });
    for (const n of extra.dependsOn ?? []) await prisma.taskDependency.create({ data: { taskId: task.id, dependsOnTaskId: created[n - 1].id } });
  }
  // Sprints for MBA: Sprint 1 finished (velocity), Sprint 2 running now (burndown, capacity); the rest is backlog.
  const mba = created[0].projectId;
  const sprint1 = await prisma.sprint.create({
    data: { projectId: mba, name: 'Sprint 1', goal: 'Designs approved', startDate: day(-20), endDate: day(-7), state: 'completed', startedAt: day(-20), completedAt: day(-7), completedPoints: 5 },
  });
  const sprint2 = await prisma.sprint.create({
    data: { projectId: mba, name: 'Sprint 2', goal: 'Log in and see the account balance', startDate: day(-6), endDate: day(7), state: 'active', startedAt: day(-6) },
  });
  await prisma.task.updateMany({ where: { id: created[0].id }, data: { sprintId: sprint1.id } });
  await prisma.task.updateMany({ where: { id: { in: [2, 3, 4, 6, 10].map((n) => created[n - 1].id) } }, data: { sprintId: sprint2.id } });

  // An open blocker on MBA-4, so the blocked-task rule can be tried.
  await prisma.issue.create({
    data: {
      workspaceId: workspace.id, projectId: created[3].projectId, taskId: created[3].id, title: 'No access to the Firebase project',
      type: IssueType.blocker, severity: SeverityLevel.high, reporterId: ids.YB, description: 'The service account key has not been shared yet.',
    },
  });

  // Messages and comments. Mentions are written as @[Name](userId), the format the app inserts.
  const mention = (k: string) => `@[${users.find((u) => u.key === k)!.fullName}](${ids[k]})`;
  const channel = await prisma.channel.findFirstOrThrow({ where: { projectId: mba, type: ChannelType.project } });
  const say = async (channelId: string, k: string, body: string, minutesAgo: number) =>
    prisma.message.create({ data: { channelId, senderId: ids[k], body, createdAt: new Date(Date.now() - minutesAgo * 60_000) } });
  await say(channel.id, 'BM', 'Morning team! Sprint 2 is halfway. Please keep your task statuses up to date.', 180);
  await say(channel.id, 'YB', `The login screen is in review. ${mention('SK')} the test build is ready for you.`, 95);
  await say(channel.id, 'SK', 'Thanks, I will start the automated tests after lunch.', 60);
  await say(channel.id, 'DT', 'Still waiting for the Firebase key, so push notifications are blocked (see the issue on MBA-4).', 20);
  await prisma.channelMember.updateMany({ where: { channelId: channel.id, userId: { in: [ids.BM, ids.YB, ids.SK] } }, data: { lastReadAt: new Date(Date.now() - 50 * 60_000) } });
  const dm = await prisma.channel.create({ data: { workspaceId: workspace.id, type: ChannelType.direct } });
  await prisma.channelMember.createMany({ data: [{ channelId: dm.id, userId: ids.BM }, { channelId: dm.id, userId: ids.HG }] });
  await say(dm.id, 'HG', 'Hi Blien, I flagged a concern on the biometric login task. Could we talk about it tomorrow?', 40);
  await prisma.comment.createMany({
    data: [
      { taskId: created[5].id, authorId: ids.YB, body: 'Ready for review: tested on Android 14 and iOS 17.', createdAt: new Date(Date.now() - 100 * 60_000) },
      { taskId: created[5].id, authorId: ids.BM, body: `Looks good. ${mention('SK')} can you add it to the regression tests?`, createdAt: new Date(Date.now() - 70 * 60_000) },
    ],
  });

  // Logged time (MBA-1 came in under its estimate; MBA-6 went over), for the time report.
  const logged: [number, string, number, number, string][] = [
    [1, 'HG', -16, 360, 'Login and onboarding wireframes'], [1, 'HG', -14, 420, 'Final designs'],
    [2, 'DT', -7, 300, 'Project setup and database schema'], [2, 'DT', -6, 240, 'Migrations and seed'],
    [3, 'DT', -3, 360, 'Balance endpoint'], [3, 'DT', -1, 240, 'Transactions endpoint'],
    [6, 'YB', -5, 420, 'Login screen layout'], [6, 'YB', -3, 300, 'Form validation and errors'],
  ];
  for (const [n, k, d, minutes, note] of logged) {
    const startedAt = new Date(day(d).getTime() + 9 * 3600_000);
    await prisma.timeEntry.create({ data: { taskId: created[n - 1].id, userId: ids[k], startedAt, endedAt: new Date(startedAt.getTime() + minutes * 60_000), minutes, source: 'manual', note } });
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

