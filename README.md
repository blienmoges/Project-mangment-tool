# Project Management Platform — Backend

The API server for the Project Management Platform, built with **NestJS**, **Prisma** and **PostgreSQL**.
It follows the *Database Design* and *API Design* documents.

## What is built so far

| Area | Endpoints |
| --- | --- |
| Authentication | `POST /auth/register`, `POST /auth/login`, `POST /auth/login/2fa`, `POST /auth/refresh`, `POST /auth/logout`, `POST /auth/password/forgot`, `POST /auth/password/reset` |
| My profile | `GET /me`, `PATCH /me`, `POST /me/avatar`, `DELETE /me/avatar`, `GET /avatars/:name`, `PATCH /me/password`, `POST /me/2fa/enable`, `POST /me/2fa/confirm`, `GET /me/2fa`, `POST /me/2fa/backup-codes`, `DELETE /me/2fa`, `GET /me/skills`, `PUT /me/skills/:skillId`, `DELETE /me/skills/:skillId` |
| Workspaces | `POST /workspaces`, `GET /workspaces/:id`, `PATCH /workspaces/:id` |
| Members | `GET /workspaces/:id/members`, `PATCH /workspaces/:id/members/:userId` (role and `canManageProjects`), `DELETE /workspaces/:id/members/:userId` |
| Invitations | `POST /workspaces/:id/invitations`, `GET /workspaces/:id/invitations`, `GET /invitations/:token`, `POST /invitations/:token/accept`, `DELETE /invitations/:invitationId` |
| Skills | `GET /workspaces/:id/skills`, `POST /workspaces/:id/skills`, `PATCH /skills/:skillId`, `DELETE /skills/:skillId`, `POST /users/:userId/skills/:skillId/verify`, `DELETE /users/:userId/skills/:skillId/verify`, `GET /workspaces/:id/members/:userId/skills` |
| Spaces | `GET /workspaces/:id/spaces`, `POST /workspaces/:id/spaces`, `GET /spaces/:spaceId`, `PATCH /spaces/:spaceId` (rename, visibility, `archived`) |
| Space members | `GET /spaces/:spaceId/members`, `POST /spaces/:spaceId/members` (`userIds`, `teamIds`), `DELETE /spaces/:spaceId/members/:userId`, `DELETE /spaces/:spaceId/teams/:teamId` |
| Workflow statuses | `GET /spaces/:spaceId/statuses`, `POST /spaces/:spaceId/statuses`, `PATCH /statuses/:statusId`, `DELETE /statuses/:statusId?moveTasksTo=` |
| Custom fields | `GET /spaces/:spaceId/custom-fields`, `POST /spaces/:spaceId/custom-fields`, `PATCH /custom-fields/:fieldId`, `DELETE /custom-fields/:fieldId` |
| Projects | `GET /spaces/:spaceId/projects`, `POST /spaces/:spaceId/projects`, `GET /projects/:projectId`, `PATCH /projects/:projectId`, `GET /projects/:projectId/dashboard`, `POST /projects/:projectId/move` |
| Project members | `GET /projects/:projectId/members`, `POST /projects/:projectId/members` (`userIds`, `teamIds`), `PATCH /projects/:projectId/members/:userId` (role), `DELETE /projects/:projectId/members/:userId`, `DELETE /projects/:projectId/teams/:teamId` |
| Phases | `GET /projects/:projectId/phases`, `POST /projects/:projectId/phases`, `PATCH /phases/:phaseId`, `DELETE /phases/:phaseId?moveTasksTo=` |
| Tasks | `GET /projects/:projectId/tasks`, `POST /projects/:projectId/tasks`, `GET /tasks/:taskId`, `GET /tasks/by-key/:shortId`, `PATCH /tasks/:taskId`, `DELETE /tasks/:taskId`, `PUT /tasks/:taskId/skills`, `POST /tasks/:taskId/dependencies`, `DELETE /tasks/:taskId/dependencies/:otherTaskId`, `GET /me/tasks` |
| Assignment | `GET /tasks/:taskId/suggestions`, `POST /tasks/:taskId/assign`, `POST /tasks/:taskId/accept`, `POST /tasks/:taskId/concern` |
| Status changes | `POST /tasks/:taskId/status`, `POST /tasks/:taskId/submit`, `POST /tasks/:taskId/approve`, `POST /tasks/:taskId/request-changes`, `POST /tasks/:taskId/reopen` |
| Sprints | `GET /projects/:projectId/sprints`, `POST /projects/:projectId/sprints`, `GET /sprints/:sprintId`, `PATCH /sprints/:sprintId`, `DELETE /sprints/:sprintId`, `POST /sprints/:sprintId/start`, `POST /sprints/:sprintId/complete`, `GET /sprints/:sprintId/burndown`, `GET /sprints/:sprintId/capacity`, `GET /projects/:projectId/backlog`, `GET /projects/:projectId/velocity` |
| Issues | `GET /projects/:projectId/issues`, `POST /projects/:projectId/issues`, `GET /issues/:issueId`, `PATCH /issues/:issueId`, `POST /issues/:issueId/assign`, `POST /issues/:issueId/status` |
| Messaging | `GET /channels`, `POST /channels/direct`, `GET /channels/:channelId/messages`, `POST /channels/:channelId/messages`, `POST /channels/:channelId/read`, `PATCH /messages/:messageId`, `DELETE /messages/:messageId`, `GET /messages/search` |
| Comments | `GET /tasks/:taskId/comments`, `POST /tasks/:taskId/comments`, `PATCH /comments/:commentId`, `DELETE /comments/:commentId` |
| Files | `POST /tasks/:taskId/attachments`, `GET /tasks/:taskId/attachments`, `POST /issues/:issueId/attachments`, `GET /issues/:issueId/attachments`, `GET /attachments/:attachmentId` (download link), `DELETE /attachments/:attachmentId`, `GET /files/:token` |
| Time tracking | `POST /tasks/:taskId/timer/start`, `POST /timer/stop`, `GET /timer`, `GET /tasks/:taskId/time-entries`, `POST /tasks/:taskId/time-entries`, `PATCH /time-entries/:entryId`, `DELETE /time-entries/:entryId`, `GET /projects/:projectId/time-report` (`?format=csv`) |
| Views | `GET /projects/:projectId/timeline`, `GET /projects/:projectId/calendar?view=month&date=`, `GET /projects/:projectId/workload?weeks=4` |
| Automations | `GET /projects/:projectId/automations`, `PATCH /projects/:projectId/automations/:ruleKey`; custom rules: `GET /projects/:projectId/automations/custom`, `POST /projects/:projectId/automations/custom`, `POST /automations/validate`, `GET /automations/:ruleId`, `PATCH /automations/:ruleId`, `DELETE /automations/:ruleId` |
| Templates | `POST /projects/:projectId/template`, `GET /workspaces/:id/templates`, `GET /templates/:templateId`, `DELETE /templates/:templateId`; use one with `templateId` in `POST /spaces/:spaceId/projects` |
| Push | `GET /push/public-key`, `POST /me/push-subscriptions`, `DELETE /me/push-subscriptions` |
| GitHub | `GET /workspaces/:id/github`, `GET /workspaces/:id/github/install`, `GET /github/callback`, `GET /workspaces/:id/github/repositories`, `GET /projects/:projectId/repositories`, `POST /projects/:projectId/repositories`, `DELETE /projects/:projectId/repositories/:repositoryId`, `GET /tasks/:taskId/code-links`, `POST /webhooks/github` |
| Activity log | `GET /workspaces/:id/activity`, `GET /projects/:projectId/activity`, `GET /tasks/:taskId/activity` |
| Notifications | `GET /notifications`, `GET /notifications/unread-count`, `POST /notifications/:id/read`, `POST /notifications/read-all`, `GET /me/notification-preferences`, `PUT /me/notification-preferences` |
| Live updates | WebSocket at `ws://localhost:3000/ws?token=<accessToken>`: `notification.created`, `message.created`, `message.updated`, `message.deleted`, `channel.read`, `typing` |
| Teams | `GET /workspaces/:id/teams`, `POST /workspaces/:id/teams`, `GET /teams/:teamId`, `PATCH /teams/:teamId`, `DELETE /teams/:teamId?keepAccess=`, `POST /teams/:teamId/members`, `DELETE /teams/:teamId/members/:userId` |

All paths start with `/api/v1`. The **database schema is complete** (all tables from the Database Design),
so the next modules only need code, not new tables.

## Project structure

```
prisma/
  schema.prisma        All tables, enums and relations
  sql/extras.sql       Rules Prisma cannot express (partial unique indexes, CHECKs, message search)
  seed.ts              Demo data (users, workspace, skills, spaces, teams)
scripts/add-extras.js  Adds extras.sql to the first migration
src/
  main.ts              Starts the server (prefix /api/v1, validation, CORS, error format)
  app.module.ts        Wires the modules together
  common/              Error format, decorators (@Public, @CurrentUser), helpers
  prisma/              Database connection
  activity/            Activity log writer
  auth/                Register, login, tokens; guard that protects every route
  users/               /me endpoints
  workspaces/          Workspaces, members, invitations, role checks
  skills/              Skills catalog
  workload/            Open hours per person (team workload now, assignment suggestions later)
  teams/               Teams; team-access.service.ts keeps team-based space/project access in sync
  spaces/              Spaces, members, workflow statuses, custom fields; space-access.service.ts
  projects/            Projects, project members, phases, project move; project-access.service.ts
  tasks/               Tasks, assignment, status changes; the rules are in task-workflow.ts and suggestions.ts
  notifications/       Notifications, settings, email (SMTP) and SMS (Twilio) delivery
  jobs/                BullMQ queues, deadline alerts and the safety sweep; timing.ts holds the alert times
  realtime/            The WebSocket at /ws
  sprints/             Sprints, backlog, burndown, velocity, capacity; sprint-math.ts holds the arithmetic
  issues/              Issue reporting; issue-rules.ts holds the status rules
  messaging/           Direct, project and team channels, messages, search
  comments/            Task comments
  files/               Attachments, file storage (disk), signed download links
  time/                Timers, manual time entries, time report and CSV export
  views/               Timeline, calendar and workload views; view-math.ts holds the calculations
  automations/         The ready-made rules and their actions
  github/              GitHub App connection, repositories, webhook, code links
  activity/            Activity log writer (ActivityService) and the activity endpoints
test/                  Checks that need no database (npm run test:logic)
```

## Setup (first time)

You need **Node.js 20+** and **Docker** (for PostgreSQL and Redis). Without Docker, install PostgreSQL 16 and Redis 7
yourself and put their addresses in `DATABASE_URL` and `REDIS_URL`.

```bash
# 1. Settings
cp .env.example .env
#    then open .env and set JWT_ACCESS_SECRET to a long random string:
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# 2. Start the database and Redis (Redis runs the reminder and email/SMS jobs)
docker compose up -d

# 3. Install packages (also generates the Prisma client)
npm install

# 4. Create the tables
npx prisma migrate dev --name init --create-only   # writes the migration file, does not run it
npm run db:add-extras                             # adds the extra rules from prisma/sql/extras.sql
npx prisma migrate dev                            # runs the migration

# 5. Add demo data (optional)
npm run db:seed

# 6. Start the API (restarts automatically when you change code)
npm run start:dev
```

The API runs at `http://localhost:3000/api/v1`.

- **API documentation (OpenAPI):** open `http://localhost:3000/api/docs` to see every endpoint with its fields, and try them
  in the browser (click **Authorize** and paste an access token). The JSON file for Postman is at `/api/docs-json`.
  It is generated from the code, so it is always up to date.
- To look inside the database, run `npm run db:studio`.

## Starting over with a fresh database

If `prisma migrate dev` reports "Drift detected" and wants to reset (for example, the database is from an earlier
setup but this folder has no `prisma/migrations`), and the database only holds demo data:
`docker compose down -v`, `docker compose up -d`, then the setup steps above. Keep `prisma/migrations` from then on
(commit it to Git).

## Updating an existing database (steps 4, 5 and 10)

Step 4 adds 13 values to the `notification_event` type and step 5 adds one more (`sprint_started`). If your database
was created before step 4:

```bash
docker compose up -d                       # also starts Redis now
npm install                                # new packages: bullmq, nodemailer, WebSocket support
npx prisma migrate dev --name notification_events --create-only
```

Open the new `prisma/migrations/<date>_notification_events/migration.sql`. It should contain only the 13
`ALTER TYPE "notification_event" ADD VALUE ...` lines shown in `prisma/sql/step4-notification-events.sql`. Delete any
other line (Prisma sometimes tries to drop the partial indexes or the `search_vector` column it does not know about),
then run `npx prisma migrate dev`. If you already did this for step 4, do the same once more for step 5 with
`--name sprint_started`; the file should contain only the line in `prisma/sql/step5-sprint-started.sql`. A database
created from scratch now needs nothing extra.

Step 10 adds two tables (`push_subscriptions`, `project_templates`), a column (`users.two_factor_backup_codes`) and one
more notification type (`automation`). Run `npx prisma migrate dev --name step10 --create-only`, compare the new file
with `prisma/sql/step10.sql` (delete any line about the partial indexes or `search_vector`), then `npx prisma migrate dev`.

## Try it

Demo data (after `npm run db:seed`): two spaces, three teams, MBA's Sprint 1 (completed) and Sprint 2 (running now), a few messages in the MBA channel and a direct message to Blien, and two projects led by Blien: Mobile Banking App
(MBA, the three teams added) and Customer Portal (CPO, in the Private Web space), with 13 tasks in every state:
done, in progress, in review (MBA-6, also overdue), a flagged concern (MBA-7), tasks waiting on dependencies, a task
blocked by an open blocker issue (MBA-4), and two unassigned tasks. Log in as Blien and open the suggestions for
MBA-8: Dawit ranks first (score 85) and Meron second (75) with the same skill match, because she is at full capacity.
Demo users (each with a demo phone number, so SMS alerts show in the log), all with the password `Password123!`:
`abel@company.com` (Workspace Admin), `blien@company.com` (Project Manager), `yonas@company.com`, `meron@company.com`,
`dawit@company.com`, `sara@company.com`, `hana@company.com`.

```bash
# Log in and keep the access token
curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"abel@company.com","password":"Password123!"}'

# Use it (replace <token>)
curl -s http://localhost:3000/api/v1/me -H "Authorization: Bearer <token>"

# Invite someone (replace <workspaceId> with the id from GET /me)
curl -s -X POST http://localhost:3000/api/v1/workspaces/<workspaceId>/invitations \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"emails":["new.person@company.com"],"role":"member"}'
```

Invitations are emailed (in development without `SMTP_URL`, the email is written to the server log). In development
the response also includes the `inviteLink`, so you can test without an inbox.
The token at the end of the link can be sent to `POST /auth/register` as `invitationToken`.

Tools like **Postman**, **Insomnia** or the VS Code **REST Client** extension are easier than curl for testing.

## How it works

- **Every route needs login** (`Authorization: Bearer <accessToken>`) unless it is marked `@Public()`.
- **Access tokens** last 15 minutes. **Refresh tokens** last 30 days, are stored only as a hash in the `sessions`
  table, sit in an HTTP-only cookie, and can be used once (each refresh gives a new one). Reusing an old one ends
  all of that person's sessions, in case it was stolen.
- **Passwords** are hashed with bcrypt.
- **Permissions:** `WorkspaceAccessService.requireMember()` / `requireAdmin()` check the caller's workspace role.
  People outside a workspace get 404, so they cannot tell it exists.
- **Errors** always look like `{ "error": { "code": "...", "message": "...", "fields": { ... } } }`.
- **Activity log:** important changes are recorded with `ActivityService.log()`.

## Spaces, workflows and teams (step 1 rules)

- **Who sees a space:** the Workspace Admin sees every space. Members see Open spaces and the Private spaces they
  belong to. Guests see only spaces they were added to. Anyone else gets 404. Archived spaces are left out of lists
  unless `?includeArchived=true`.
- **New spaces** start with the workflow To do (not started), In progress (active), In review (review), Done (closed).
- **Workflow order:** statuses always stay in the order Not started → Active → Review → Closed, so a custom status
  such as Testing (active) sits before In review. A `position` outside its category's block is refused with
  `VALIDATION_FAILED`; leave it out to add the status at the end of its block.
- **Every space keeps at least one status in each category** (`409 WORKFLOW_CATEGORY_REQUIRED`).
- **Deleting a status that tasks use** needs `?moveTasksTo=<statusId>` of the same category, so tasks are never
  closed or reopened without the approve action. For the same reason, a status's category can only change while no
  task uses it (`409 STATUS_IN_USE`).
- **Custom fields:** types text, number, dropdown, checkbox, date. Dropdown choices are `{ id, label, color? }`; tasks
  store the choice `id`, so renaming a choice changes nothing on tasks. When a choice is removed, task values that used
  it are cleared and the response says how many (`clearedValues`). The type cannot change after creation.
  `src/spaces/custom-field-values.ts` checks task values and is ready for the tasks module.
- **Teams give access as a unit.** Adding a team to a space (or, in step 2, to a project) adds its members with
  `added_via_team_id` set, and people who join the team later get the same access. People who were already members
  keep their own row. When access through a team ends (person leaves the team, team is removed from the space or
  deleted), the row passes to another of the person's teams that gives the same access, or is removed. The Project
  Manager is never removed this way. Someone who loses a project has their unfinished tasks in it unassigned.
  Adding a team to a project in a Private space also adds its members to the space.
- **Deleting a team:** by default, access people had only through the team is removed. With `?keepAccess=true` they
  stay in those spaces and projects as direct members.
- **Removing a person from a space** works only for people added directly (`409 MEMBER_VIA_TEAM` otherwise) and who
  are not members of any project in the space (`409 STILL_PROJECT_MEMBER`).
- **Team workload** counts the estimated hours of each person's unfinished tasks in this workspace against their
  weekly capacity (`loadPercent`). `GET /teams/:teamId` also lists skills coverage (FR-10.5).

## Projects, members and phases (step 2 rules)

- **Who can open a project:** the Workspace Admin opens every project; everyone else only the projects they are a
  member of (also in space overviews and project lists). Project checks follow the API Design's order: not in the
  workspace or cannot see the space → 404; wrong project role → 403. `ProjectAccessService.require(projectId, userId,
  'read' | 'member' | 'manage' | 'admin')` does this for every module that follows.
- **Creating a project:** the Admin, or a Member with `canManageProjects` who can see the space. The caller becomes the
  Project Manager, or names one with `managerId` (that person also needs the permission). A Member who names someone
  else stays in the project as a Team Member. The key prefix (2 to 5 capitals or digits, such as MBA) is unique in the
  workspace and cannot change, because task IDs and GitHub links use it. `endDate` must be after `startDate`.
- **Every project gets its group channel** (FR-5.2) when it is created. Its members always match the project's
  members except Guests, so the messaging module only has to add messages.
- **Exactly one Project Manager:** the PM cannot be removed from the project, demoted, removed from the workspace or
  made a Guest (`409 PROJECT_MANAGER_REQUIRED`). The Admin hands the role over with
  `PATCH /projects/:id/members/:userId` and `{ "role": "project_manager" }`; the previous PM becomes a Team Member.
- **Guests** always have the `guest` project role (read-only). A Member made Guest keeps their projects as a Guest,
  loses their open tasks, and must first leave their teams (`409 STILL_TEAM_MEMBER`). A Guest made Member becomes a
  Team Member in their projects.
- **Project members must see the project's space:** people added to a project in a Private space (and Guests in any
  space) are also added to the space. Switching a space to Private adds its project members to it.
- **Read-only:** a project in an archived space, or an archived project, refuses changes (`409 SPACE_ARCHIVED`,
  `409 PROJECT_ARCHIVED`). Setting `status` to `archived` archives a project; any other status restores it.
- **Dashboard** (`GET /projects/:id/dashboard`): progress, done/total and overdue tasks, open and critical issues,
  blocked tasks, the active sprint, phases with progress, and the prototype's Needs attention list
  (`overdue`, `awaiting_approval`, `concern`, `unassigned`). "Overdue" means due before today in the workspace's
  time zone and not done.
- **Phases** are ordered (`position`) and may have a due date; deleting one moves its tasks to `?moveTasksTo=` or
  leaves them without a phase. Changing the due date clears `overdue_notified_at`, so the missed-phase alert can fire
  again.
- **Moving a project** (Admin): one transaction, as the API Design says. Statuses map by `statusMapping`, then same
  name, then the first status of the same category; a closed status always maps to a closed one. Custom-field values
  move to a field of the same name and type in the new space (dropdown choices by label) and are removed otherwise.
  `"dryRun": true` does the whole move and rolls it back, so the report is exact.

## Tasks, assignment and the workflow (step 3 rules)

- **Creating and editing** tasks is for the PM and Admin. Status and assignee change only through the action
  endpoints. Task numbers come from the project's counter inside a transaction, so short IDs such as MBA-42 are
  unique. Subtasks are one level deep and take the parent's phase and sprint by default. Tasks can only join planned
  or active sprints of the same project. `dueDate` must be on or after `startDate`.
- **Calculated fields** on every task: `shortId`, `overdue` (due before today in the workspace's time zone and not
  done), `blocked` (an open blocker issue is linked), `waitingOn` (unfinished dependencies), subtask counts.
  `GET /tasks/:id` adds a `permissions` object, including `allowedMoves`: the statuses `POST /status` would accept from
  the caller right now, so the app only offers valid moves.
- **Task list** filters: `status` (an id or a category), `assigneeId` (`me`, `none` or an id), `phaseId`
  (`none` or an id), `sprintId` (`backlog` or an id), `parentTaskId` (`none` for top-level tasks), `priority`,
  `overdue=true`, `q` (title and description; a short ID such as MBA-42 finds that task), `cf[<fieldId>]=value`;
  `sort` such as `-dueDate`; `limit` (up to 100) and `cursor` paging, answered as `{ data, nextCursor }`.
- **Suggestions** follow the API Design's formula exactly (`src/tasks/suggestions.ts`): candidates are the project's
  Team Members (`?includeManager=true` adds the PM; `?teamId=` narrows to a team), score = 0.75 × skill match +
  0.25 × free capacity, with the documented tie-breaks and flags. Below-level skills are listed separately in
  `partialSkills`. When reassigning, the current assignee's load leaves out the task itself, so the comparison is fair.
  Workload counts unfinished tasks in this workspace.
- **Assignment:** the PM confirms (`POST /assign`); the person must be a project member who is not a Guest
  (`422 NOT_PROJECT_MEMBER`). The task then waits for the assignee to accept or flag a concern; a concern shows
  under Needs attention. `{ "userId": null }` unassigns. Finished tasks cannot be reassigned (`409 TASK_CLOSED`).
- **Workflow rules** (`src/tasks/task-workflow.ts`), checked whichever endpoint is used:
  only `/approve` closes a task (`403 APPROVAL_REQUIRED`), and only from review; the assignee moves their own task
  between Not started and Active statuses and into review; during review only the PM or Admin can act; the PM and
  Admin can move a task to any status that is not closed; a closed task changes only through `/reopen`; a blocked
  task cannot move forward (`409 TASK_BLOCKED`); a task cannot leave Not started while a dependency is unfinished
  (`409 DEPENDENCY_NOT_DONE`); `completedAt` is set on approval and cleared on reopen. Request changes adds its note
  to the task's comments.
- **Dependencies** stay within one project; a dependency that would make a loop is refused (`409 DEPENDENCY_LOOP`).
- **Changing a due date** clears the task's sent reminders and its overdue flag, so step 4's jobs fire again for the
  new date.

## Notifications and deadline alerts (step 4 rules)

- **What people get:** every notification appears in the app; email and SMS follow each person's settings per event
  type and workspace (`/me/notification-preferences`). By default every event is emailed and SMS is used only for
  overdue tasks and Critical issues (FR-4.5, constraint 2.5). SMS needs a phone number on the profile. Push (FR-4.6)
  is stored as a setting but not sent yet.
- **Alert times** (workspace time zone, `src/jobs/timing.ts`): reminders at 09:00 on each reminder day (2 and 1 days
  before by default, set per workspace) go to the assignee; the overdue alert at 00:00 the day after the due date goes
  to the assignee and the PM, then repeats daily at 09:00 until the task is done or gets a new date (FR-4.2–4.4); a
  phase still unfinished after its due date alerts the PM at 00:05 the next day. Unassigned tasks get no reminders,
  but their overdue alert still reaches the PM.
- **Exact-time jobs + safety sweep** (NFR-2): creating, assigning, reopening or re-dating a task schedules BullMQ
  delayed jobs for its exact moments; approving or deleting it cancels them. A sweep every 15 minutes (and right
  after start-up) sends anything that should already have gone out. Each alert is claimed in the database before it is
  sent (a `task_reminders` row, or `overdue_notified_at` moved forward), so the jobs and the sweep never send the same
  alert twice, and jobs re-check the task when they fire, so leftovers from an old date do nothing. A reminder more
  than a day late is dropped as stale. Changing the workspace's time zone or reminder days reschedules everything.
- **Sending:** after the change is saved (never if it is rolled back), the person's open app gets `notification.created`
  with the new unread count, and each email/SMS is queued. Failed sends are retried 3 times (after 30 s, 60 s and
  120 s) and then marked `failed` with the error. Without `SMTP_URL` / `TWILIO_*` settings, development writes emails
  and SMS to the server log; production refuses to pretend and records the failure instead.
- **If Redis is down,** the API keeps working: queueing gives up after 2 seconds, the email/SMS rows stay `queued`, and
  the sweep sends them once Redis is back. With `JOBS_ENABLED=false` the server runs without Redis at all
  (development only): alerts are checked every minute in the API process.
- **WebSocket:** connect to `/ws?token=<accessToken>` (or send an `Authorization: Bearer` header). The server sends
  `{ "event": "ready" }`, then events such as `{ "event": "notification.created", "data": { "notification", "unreadCount" } }`.
  The connection closes with code **4401** when the token is missing, invalid or expires: refresh the token and
  reconnect. One API process is assumed for now; several would need Redis pub/sub between them.
- **Measuring NFR-2:** each notification stores when it was due (`triggered_at`) and each delivery when it was sent:

```sql
SELECT n.event_type, d.channel, count(*) AS sent,
       percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM d.sent_at - n.triggered_at)) AS p99_seconds
FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id
WHERE d.status = 'sent' AND n.event_type IN ('reminder', 'overdue') GROUP BY 1, 2;
```

## Sprints and issues (step 5 rules)

- **Sprints** go planned → active → completed, with one active sprint per project (`409 SPRINT_ALREADY_ACTIVE`; the
  database's partial index also catches two starts at the same moment). A new sprint lasts two weeks by default and
  starts the day after the latest sprint ends (or today). Starting a sprint notifies the project's members (Roles
  guide P6). Completing it stores the completed story points, for velocity, and moves the unfinished tasks to the
  backlog or a planned sprint (FR-12.5). Only a sprint that has not started can be deleted; its tasks go back to the
  backlog. Tasks move between the backlog and a sprint with `PATCH /tasks/:id` and `sprintId`.
- **Burndown:** for each sprint day, the story points of the sprint's tasks not yet completed at the end of that day
  (by `completedAt`, in the workspace time zone), with the ideal line from the total to 0; days still to come are
  `null`. A completed sprint's chart also counts the tasks that were moved out unfinished (their ids are kept in the
  activity log), so it still shows what was left.
- **Velocity:** completed points of the last six completed sprints and their average. **Backlog:** unfinished tasks in
  no sprint, highest priority first, with total points and hours.
- **Capacity** follows the API Design exactly: points against the average of the last 3 completed sprints when there
  are any, hours otherwise (each member's weekly hours × the sprint's working days ÷ working days per week, minus their
  unfinished work in other projects due during the sprint); `ok`, `near` (90% or more) or `over`, with a per-person list.
- **Issues:** any project member except Guests reports one. The PM and the linked task's assignee are notified; a
  Critical issue alerts the whole project team (SMS by default), also when an issue is raised to Critical later
  (FR-6.3). An open or in-progress blocker linked to a task blocks it (`blocksTask`), and step 3's rules then stop the
  task moving forward. The PM chooses the fixer. The reporter, the fixer, the PM and the Admin move an issue through
  open → in progress → resolved → closed; closing and reopening a closed issue are for the PM and Admin. Resolving
  notifies the reporter (FR-6.5) and, for a blocker, the task's assignee. `permissions.allowedStatuses` lists the moves
  the caller may make. Screenshots and log files come with the attachments module (next part).

## Messaging, comments and files (step 6 rules)

- **Channels:** every project has one (created with the project), every team has one (created the first time someone
  lists their channels, so older teams get one too), and two people can open a direct conversation (one per pair and
  workspace). Membership follows the project and the team automatically. Guests cannot send or receive messages.
  `GET /channels` gives each channel's name, last message and unread count (messages from others after
  `lastReadAt`); `POST /channels/:id/read` marks it read and tells the others ("Seen", FR-5.3).
- **Messages** are sent with REST and pushed to the channel's members as `message.created`; edits and deletions
  (own messages only) push `message.updated` / `message.deleted`. The app sends `{ "event": "typing",
  "data": { "channelId" } }` and the other members receive `typing`. A message can carry up to 5 files: send it as
  multipart/form-data with `body` and `files` (the database requires every file to belong to a task, issue or
  message, so files cannot be uploaded ahead of the message). The channel of an archived project is read-only.
- **Search** (`GET /messages/search?q=`) uses PostgreSQL full-text search on the caller's own conversations; all words
  must appear.
- **@mentions** are written by the app as `@[Meron Alemu](<userId>)` when someone picks a person, so names can repeat or
  change. Mentioned people get a `mention` notification, but only if they can see the message or comment (channel
  members; for comments, project members who are not Guests, and Admins).
- **Comments:** project members (not Guests) and the Admin comment on tasks; the author edits or deletes their own.
- **Files** (tasks, issues, messages) are up to 20 MB (`413 FILE_TOO_LARGE`) and stored under `UPLOAD_DIR`; back that
  folder up with the database. `GET /attachments/:id` checks that the caller can see the task, issue or message and
  returns a link valid for 5 minutes, so images can be shown with a normal `<img>` tag. Images, PDF and plain text
  open in the browser; every other type (including SVG and HTML) is downloaded, with `nosniff` and a sandbox policy,
  so an uploaded file can never run script in the app. The uploader, the PM and the Admin can remove a file;
  deleting a task or message removes its files too. To move files to cloud storage later, replace `StorageService`.

## Time tracking, views and automations (step 7 rules)

- **Timers:** the task's assignee or the PM starts one; each person has one running timer at most
  (`409 TIMER_RUNNING`, also guaranteed by the database's partial index). Stopping saves whole minutes (at least 1).
  Approving a task stops any timer still running on it. Time can also be added by hand (`minutes`, `date`, `note`) by
  the same people, even on finished tasks; people edit or delete only their own entries.
- **Estimate versus logged** (FR-13.3): `GET /tasks/:id/time-entries` returns the entries and a summary with estimated,
  logged and remaining minutes, `overEstimate`, and minutes per person.
- **Time report** (PM, Admin; FR-13.4): hours per person, task and sprint between `from` and `to` (workspace time zone).
  `?format=csv` downloads the entries as a spreadsheet file; values that look like formulas are neutralised, and the
  file is marked UTF-8 so Excel shows names correctly.
- **Timeline:** every task with a start or due date (a task with one date is a one-day bar), its dependencies, phases and
  sprints. **Calendar:** the month (whole weeks, from the Monday before the 1st) or the week around `date`, each day
  with its tasks (by due date), sprint starts and ends, phase due dates and the project's end; `?assigneeId=me`.
  Moving a task to another day is `PATCH /tasks/:id` with a new `dueDate`. Both are open to Guests.
- **Workload** (PM, Admin): for each project member and week, the hours of their open work in all their projects in
  the workspace (each estimate spread evenly over the working days up to its due date; overdue work counts today), how
  much of it is this project, and capacity (this week only counts the working days still ahead). `near` from 85%,
  `over` above 100%. Tasks without a due date or an estimate are listed separately, not guessed.
- **Ready-made automations** (all on by default, switched per project): `review_notify` (the PM is notified when a task
  moves to review), `subtasks_done` (when the last subtask is approved, the parent moves to the first Review status,
  unless it is blocked or still waits on a dependency), `critical_priority` (a Critical issue raises its linked task to
  High). `pr_merged` is listed but needs GitHub (step 8). Rule actions are logged with actor type `automation` and never
  trigger other rules, so rules cannot loop. The prototype also shows "Notify the Team Lead when a task becomes
  overdue"; it is not in the API Design and teams have no lead in the schema, so it is left out for now.

## GitHub and the activity log (step 8 rules)

- **Setting up GitHub** (once per server): create a GitHub App (see `.env.example` for the permissions, events and URLs)
  and fill in the `GITHUB_*` settings. Then a Workspace Admin opens Settings → GitHub in the app, which calls
  `GET /workspaces/:id/github/install` and sends them to GitHub to install it on their organisation. GitHub sends the
  browser back to `/github/callback`, which connects the installation and redirects to `WEB_ORIGIN/settings/github`.
- **Safety:** the install link carries a signed state (which Admin, which workspace, 30 minutes). Because installation
  ids are guessable numbers, the callback also asks GitHub whether the person can really access the installation
  (needs the App's OAuth client id and secret; required in production). Without them, development only accepts an
  installation created in the last 15 minutes that no workspace has claimed. The app only reads repository metadata,
  never source code (Database Design, section 7).
- **Linking:** the Admin or a PM lists the repositories GitHub shows (`GET /workspaces/:id/github/repositories`); the
  Admin links one to a project. A task key such as MBA-42 is only matched in repositories linked to that task's project.
- **Webhook** (`POST /webhooks/github`): every request must carry a valid `X-Hub-Signature-256` for the exact bytes
  received (`GITHUB_WEBHOOK_SECRET`; without it every webhook is refused). Pushes link the branch (by its name) and
  each commit (by its message); pull requests are linked by title, branch and description, and follow their state:
  open, merged, closed. Task keys are written like MBA-42, mba-42 or MBA_42 (not inside emails or web addresses).
  Links are upserts, so GitHub's redeliveries change nothing. A merged pull request moves its task to review when the
  `pr_merged` rule is on (not if the task is blocked, already in review or done, or still waits on a dependency); the
  PM is told. Removing the app or a repository on GitHub removes its links.
- **Activity log** (NFR-9): every change is recorded with who did it (a person, an automation, GitHub or the system).
  The Admin reads the workspace's history, the PM and Admin a project's (the project and its tasks, issues, sprints and
  phases), and project members a task's. Filters: `actorId`, `entityType`, `from`, `to`; pages with `limit` and
  `cursor`. Entries cannot be changed or deleted through the API.

## Account security and skill verification (step 9 rules)

- **Two-factor login** (NFR-4) with any authenticator app (Google Authenticator, Microsoft Authenticator...; RFC 6238
  codes, checked against the RFC's own test values). `POST /me/2fa/enable` returns a QR code (PNG) and the secret for
  typing in; `POST /me/2fa/confirm` with the first code switches it on; `DELETE /me/2fa` with the password switches it
  off. Once on, `POST /auth/login` answers `{ "twoFactorRequired": true, "challengeId" }` instead of tokens, and
  `POST /auth/login/2fa` with the code finishes. A challenge lasts 5 minutes, works once and dies after 5 wrong codes;
  the same code is never accepted twice. The secret is stored encrypted (AES-256-GCM, key from `DATA_ENCRYPTION_KEY`).
- **Password reset:** `POST /auth/password/forgot` always gives the same answer, so it cannot reveal who has an
  account; the email's link works for one hour and only once (it is signed with a key that includes the current
  password, so it stops working when the password changes). Resetting signs the account out everywhere.
  `PATCH /me/password` needs the current password and signs out the other sessions.
- **Rate limits** (`429 RATE_LIMITED`): 10 password tries per email and 50 requests per address in 15 minutes for login,
  the code step and reset; 5 reset emails per email an hour. Behind a proxy set `TRUST_PROXY` so limits see real
  addresses. A wrong email and a wrong password take the same time to answer, so response times do not reveal which
  emails are registered (measured: about 350 ms either way).
- **Skill verification** (FR-10.2): the Workspace Admin, or the PM of a project the person works in, confirms the level
  a person gave themselves; nobody verifies their own. Verified skills win ties in suggestions; changing the level
  clears the verification.
- **Profile photo:** PNG, JPEG or WebP up to 2 MB, recognised by the file's bytes (an SVG renamed to .png is refused).
  Each photo gets a new random address, served without login so `<img>` tags work; the old photo is deleted.
- **Limits of this version:** the challenge, rate-limit and used-code records live in the API process's memory (one
  process, like the WebSocket); several processes would keep them in Redis. Someone who loses their phone signs in with
  a backup code (step 10).

## Custom rules, push, templates and backup codes (step 10 rules)

- **Custom automation rules** (FR-15.3, Workspace Admin): one trigger (`task.created`, `task.status_changed` with an
  optional `toStatusId`, `task.assigned`, `task.overdue`, `issue.created`, `pull_request.merged`), conditions that must
  all hold (`task.priority`, `task.assigneeId`, `task.phaseId`, `task.sprintId`, `task.statusCategory`, `issue.severity`,
  `issue.type` with `equals`, `not_equals`, `in`, `not_in`, `is_empty`, `is_not_empty`) and 1–5 actions: `notify`
  (assignee, manager, reporter, people or a team, with a message using `{task}`, `{task.title}`, `{task.shortId}`,
  `{issue.title}`, `{project}`, `{rule}`), `set_priority`, `move_status`, `add_comment`. Every problem is reported at once
  (`422 INVALID_AUTOMATION_RULE`, with `fields`); `POST /automations/validate` checks a rule without saving it.
  Rules cannot close tasks (only the PM's approval does) or assign people (the PM always confirms), `move_status` still
  obeys the workflow rules (no forward move for blocked tasks), and rule actions never trigger other rules, so rules
  cannot loop. Rules run inside the change that triggers them; each run is in the activity log (actor `automation`).
  `task.overdue` rules run once, with the first overdue alert. At most 50 custom rules per project.
- **Push notifications** (FR-4.6): Web Push to browsers and installed web apps. The app asks `GET /push/public-key`,
  subscribes with the browser's `pushManager.subscribe()` and sends the result to `POST /me/push-subscriptions`. Push
  follows each person's settings (`push` per event type, off by default); subscriptions the browser has withdrawn are
  deleted. Needs the `VAPID_*` settings.
- **Project templates** (FR-1.5): a PM saves a project as a template (phases and tasks with their dates as days from the
  start, subtasks, required skills, estimates, story points, priorities, dependencies; not people, progress, comments or
  time). `POST /spaces/:id/projects` with `templateId` creates them all, dated from the new start date, and schedules
  their reminders. Skills are matched by id, or by name if re-created; skills no longer in the catalog are left out.
- **Two-factor backup codes:** switching two-factor on returns 10 codes like `k7m2-qx4pa`, shown once. Each works once
  instead of the app's code at `POST /auth/login/2fa` (the answer then says how many are left); they are stored only as
  HMAC hashes. `POST /me/2fa/backup-codes` (with the password) makes 10 new ones and voids the old ones.

## Tests

`npm run test:logic` runs the checks that need nothing else (workflow rules, ranking, team access, alert times...).
`npm run test:e2e` is the full end-to-end test: 116 checks through the real API against a real PostgreSQL database and
Redis, covering every module (login, tasks and the approval workflow, suggestions, notifications with email and SMS,
issues, sprints, messaging, files, time tracking, views, automations, templates, two-factor login, password reset...).
Run it against a freshly seeded database: `npx prisma migrate reset`, then `npm run start:dev`, then `npm run test:e2e`
in another terminal (set `GITHUB_WEBHOOK_SECRET=hook-secret` in `.env` for its webhook checks). Before release it
passed 116 of 116 on PostgreSQL 16 and Redis.

`npm run test:integration` needs Redis. It tests the real BullMQ queues, the deadline alerts end to end over an
in-memory database, delivery retries, and the uploads, download links, notifications and typing through the real HTTP
server and WebSocket. It uses Redis database 15 (`TEST_REDIS_URL`), which it empties.

## Notes

- **Who can create projects:** Members need the `canManageProjects` permission, which the Workspace Admin switches on with
  `PATCH /workspaces/:id/members/:userId` and `{ "canManageProjects": true }`. In the demo data, Abel and Blien have it.
- **Time zone:** each workspace has a `timezone` (demo: Africa/Addis_Ababa). Reminders, overdue alerts and overdue flags use
  it; calendar weeks will too. Working days do not affect alert times yet.

- One table was added to the Database Design: **`sessions`**, for refresh tokens.
- **Partial indexes in `extras.sql`:** Prisma does not know about them. If a future `prisma migrate dev` generates
  a migration that tries to `DROP` `project_members_one_pm`, `sprints_one_active` or `time_entries_one_running`,
  delete those lines from the migration file before applying it.
- Emails are stored in lower case so `Blien@Company.com` and `blien@company.com` are the same account.
- **Additions to the API Design** (step 10): the custom-rule format (trigger `toStatusId`, the condition fields and
  operators, the four actions and the message placeholders), `GET /me/2fa`, `POST /me/2fa/backup-codes`, the push and
  template endpoints, `templateId` on project creation; tables `push_subscriptions` and `project_templates` and column
  `users.two_factor_backup_codes` for the Database Design; error codes `409 TOO_MANY_RULES` and `409 PUSH_NOT_CONFIGURED`.
- **Additions to the API Design** (step 9): `DELETE /me/avatar`, `GET /avatars/:name`, `DELETE /users/:userId/skills/:skillId/verify`,
  `GET /workspaces/:id/members/:userId/skills`; the 2FA setup response (`qrCode`, `otpauthUrl`, `secret`); error codes
  `410 RESET_LINK_INVALID`, `409 TWO_FACTOR_ALREADY_ON` and `409 TWO_FACTOR_NOT_STARTED`.
- **Additions to the API Design** (step 8): `GET /workspaces/:id/github` (status), `GET /projects/:id/repositories`;
  the callback's redirect to `WEB_ORIGIN/settings/github?status=connected|error`; the webhook's 202 answer; the
  activity endpoints' `cursor` paging; error codes `409 GITHUB_NOT_CONFIGURED` and `409 GITHUB_UNAVAILABLE`.
- **Additions to the API Design** (step 7): `?assigneeId=` on the calendar; `project_end` calendar events; the timeline,
  workload and time-report response shapes; `from`/`to` on the time report; `available` on automation rules; the error
  codes `409 TIMER_RUNNING`, `409 NO_TIMER_RUNNING` and `409 TASK_CLOSED` for timers on finished tasks.
- **Additions to the API Design** (step 6): the mention format `@[Name](userId)`; multipart messages instead of
  "attachment IDs" (because of the attachments CHECK constraint); `GET /tasks/:id/attachments`,
  `GET /issues/:id/attachments` and `GET /files/:token`; the WebSocket events `message.updated` and `message.deleted`;
  `?workspaceId=` on `GET /channels`, `POST /channels/direct` and search; the error code `410 LINK_EXPIRED`.
- **Additions to the API Design** (step 5): `GET /sprints/:id`, `DELETE /sprints/:id` (planned sprints only), default
  sprint dates, `?status=unresolved` and `?assigneeId=` on issues, `blocksTask` and `permissions.allowedStatuses` on
  issues, the notification type `sprint_started`, and the error codes `409 SPRINT_NOT_PLANNED`, `409 SPRINT_NOT_ACTIVE`
  and `409 SPRINT_COMPLETED`.
- **Additions to the API Design** (step 4): 13 notification event types (`task_accepted`, `task_concern`,
  `review_requested`, `task_approved`, `changes_requested`, `task_reopened`, `due_date_changed`, `ready_to_start`,
  `phase_overdue`, `added_to_project`, `made_manager`, `project_moved`, `member_removed`); the notification `link`
  object; `byWorkspace` in the unread count; `?workspaceId=` on the settings endpoints; the WebSocket `ready` event and
  close code 4401. Database Design: no table changes, only the new enum values.
- **Additions to the API Design** (step 3): `GET /me/tasks` (listed in the API Design, built now), `?workspaceId=` on
  `GET /tasks/by-key/:shortId` for people in several workspaces, the `permissions` and `allowedMoves` objects,
  `partialSkills` in suggestions, `{ "userId": null }` to unassign, and the error code `409 TASK_CLOSED`.
- **Additions to the API Design** (step 2): `DELETE /projects/:projectId/teams/:teamId`, `?moveTasksTo=` on phase
  deletion, the `permissions` object in `GET /projects/:id`, and the error codes `409 PROJECT_MANAGER_REQUIRED`,
  `409 SPACE_ARCHIVED`, `409 PROJECT_ARCHIVED` and `409 STILL_TEAM_MEMBER`.
- **Additions to the API Design** (step 1): `GET /spaces/:spaceId/members`, `DELETE /spaces/:spaceId/teams/:teamId`,
  `GET /teams/:teamId`, the `?keepAccess=` option on team deletion, and the error codes `409 STATUS_IN_USE`,
  `409 MEMBER_VIA_TEAM` and `409 STILL_PROJECT_MEMBER`.
- The database schema did not change in steps 1 to 3. Step 4 adds enum values only (see "Updating an existing database").

## Next steps

1. ~~Spaces, workflow statuses, custom fields and teams~~ (done)
2. ~~Projects, members and phases~~ (done)
3. ~~Tasks, assignment suggestions and status changes~~ (done)
4. ~~Notifications, email and SMS, deadline alerts~~ (done)
5. ~~Sprints and issues~~ (done)
6. ~~Messaging, task comments, @mentions and attachments~~ (done)
7. ~~Time tracking, timeline / calendar / workload views, ready-made automations~~ (done)
8. ~~GitHub integration and the activity log~~ (done)
9. ~~Two-factor login, password reset, skill verification, profile photo~~ (done)
10. ~~Custom automation rules, push notifications, project templates, two-factor backup codes~~ (done: every requirement in the SRS is built)

