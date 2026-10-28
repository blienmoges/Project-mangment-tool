# Project Management Platform — Backend

The API server for the Project Management Platform, built with **NestJS**, **Prisma** and **PostgreSQL**.
It follows the *Database Design* and *API Design* documents.

## What is built so far

| Area | Endpoints |
| --- | --- |
| Authentication | `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout` |
| My profile | `GET /me`, `PATCH /me`, `GET /me/skills`, `PUT /me/skills/:skillId`, `DELETE /me/skills/:skillId` |
| Workspaces | `POST /workspaces`, `GET /workspaces/:id`, `PATCH /workspaces/:id` |
| Members | `GET /workspaces/:id/members`, `PATCH /workspaces/:id/members/:userId` (role and `canManageProjects`), `DELETE /workspaces/:id/members/:userId` |
| Invitations | `POST /workspaces/:id/invitations`, `GET /workspaces/:id/invitations`, `GET /invitations/:token`, `POST /invitations/:token/accept`, `DELETE /invitations/:invitationId` |
| Skills catalog | `GET /workspaces/:id/skills`, `POST /workspaces/:id/skills`, `PATCH /skills/:skillId`, `DELETE /skills/:skillId` |
| Spaces | `GET /workspaces/:id/spaces`, `POST /workspaces/:id/spaces`, `GET /spaces/:spaceId`, `PATCH /spaces/:spaceId` (rename, visibility, `archived`) |
| Space members | `GET /spaces/:spaceId/members`, `POST /spaces/:spaceId/members` (`userIds`, `teamIds`), `DELETE /spaces/:spaceId/members/:userId`, `DELETE /spaces/:spaceId/teams/:teamId` |
| Workflow statuses | `GET /spaces/:spaceId/statuses`, `POST /spaces/:spaceId/statuses`, `PATCH /statuses/:statusId`, `DELETE /statuses/:statusId?moveTasksTo=` |
| Custom fields | `GET /spaces/:spaceId/custom-fields`, `POST /spaces/:spaceId/custom-fields`, `PATCH /custom-fields/:fieldId`, `DELETE /custom-fields/:fieldId` |
| Projects | `GET /spaces/:spaceId/projects`, `POST /spaces/:spaceId/projects`, `GET /projects/:projectId`, `PATCH /projects/:projectId`, `GET /projects/:projectId/dashboard`, `POST /projects/:projectId/move` |
| Project members | `GET /projects/:projectId/members`, `POST /projects/:projectId/members` (`userIds`, `teamIds`), `PATCH /projects/:projectId/members/:userId` (role), `DELETE /projects/:projectId/members/:userId`, `DELETE /projects/:projectId/teams/:teamId` |
| Tasks | `GET /projects/:projectId/tasks`, `POST /projects/:projectId/tasks`, `GET /tasks/:taskId`, `GET /tasks/by-key/:shortId`, `PATCH /tasks/:taskId`, `DELETE /tasks/:taskId`, `PUT /tasks/:taskId/skills`, `POST /tasks/:taskId/dependencies`, `DELETE /tasks/:taskId/dependencies/:otherTaskId`, `GET /me/tasks` |
| Assignment | `GET /tasks/:taskId/suggestions`, `POST /tasks/:taskId/assign`, `POST /tasks/:taskId/accept`, `POST /tasks/:taskId/concern` |
| Status changes | `POST /tasks/:taskId/status`, `POST /tasks/:taskId/submit`, `POST /tasks/:taskId/approve`, `POST /tasks/:taskId/request-changes`, `POST /tasks/:taskId/reopen` |
| Phases | `GET /projects/:projectId/phases`, `POST /projects/:projectId/phases`, `PATCH /phases/:phaseId`, `DELETE /phases/:phaseId?moveTasksTo=` |
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
  tasks/               Tasks, assignment and status changes; suggestions.ts and workflow-rules.ts hold the rules
  events/              In-process event bus: task changes are published for notifications, jobs and automations
test/                  Checks that need no database (npm run test:logic)
```

## Setup (first time)

You need **Node.js 20+** and **Docker** (for the database). Without Docker, install PostgreSQL 16 yourself
and put its address in `DATABASE_URL`.

```bash
# 1. Settings
cp .env.example .env
#    then open .env and set JWT_ACCESS_SECRET to a long random string:
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# 2. Start the database
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

## Try it

Demo data (after `npm run db:seed`): two spaces, three teams, and two projects led by Blien: Mobile Banking App
(MBA, the three teams added) and Customer Portal (CPO, in the Private Web space), with the prototype's twelve tasks.
MBA-8 and MBA-9 are unassigned: log in as Blien and call `GET /tasks/<id>/suggestions` on them to see the ranking. Demo users, all with the password `Password123!`:
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

In development the invitation response includes an `inviteLink`, because email sending is not built yet.
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

- **Creating tasks** (PM, Admin): the task gets the next number of its project (MBA-1, MBA-2, ...), starts in the
  first Not started status unless `statusId` names another non-closed one, and can carry required skills and custom
  field values (`customFields: { "<fieldId>": value }`). Subtasks are one level deep. `dueDate` must be on or after
  `startDate`. Tasks can only go into planned or active sprints of the same project.
- **Changing the due date** clears the task's sent reminders and `overdue_notified_at`, so reminders and the
  overdue alert start again for the new date, and publishes `task.due_date_changed`.
- **Task list:** filters `status` (id or category), `assigneeId` (id, `me`, `none`), `phaseId` (id, `none`),
  `sprintId` (id, `backlog`), `parentTaskId`, `topLevel`, `overdue`, `priority`, `q` (text or a short ID such as
  MBA-42), `fieldId` + `fieldValue`; `sort` by `dueDate`, `priority`, `createdAt`, `updatedAt` or `number`
  (`-` for descending); `limit` (25, up to 100) with `nextCursor`.
- **Task details** include `overdue`, `blocked` (an open blocker issue), the blockers, subtasks, dependencies,
  custom field values, `permissions` and `allowedMoves`: the statuses the caller may move the task to right now,
  worked out with the same rules the server enforces, so the board can grey out the others.
- **Suggestions** follow the API Design's formula exactly (`src/tasks/suggestions.ts`): 75% skill match, 25% free
  time, the stated tie-breaks, `nearCapacity` at 85% load and `overCapacity` above 100%. People are flagged, never
  hidden. Candidates are the project's Team Members (plus the PM with `?includeManager=true`), optionally limited to
  `?teamId=`. Open hours count unfinished tasks in this workspace, leaving out the task being assigned.
  Each result lists `matchedSkills` (at or above the minimum), `belowLevelSkills` and `missingSkills`.
- **Assigning** is always the PM's confirmed choice: `{ "userId": ... }`, or `{ "userId": null }` to unassign.
  The person must be a project member who is not a Guest (`422 NOT_PROJECT_MEMBER`). The assignee then accepts or
  flags a concern; only the assignee can. Finished tasks cannot be reassigned or accepted (`409 TASK_CLOSED`).
- **Workflow rules** (`src/tasks/workflow-rules.ts`), checked whichever endpoint is used:
  only `approve` puts a task in a closed status (`403 APPROVAL_REQUIRED` otherwise, even for the PM), and only from
  review (`409 INVALID_STATUS_CHANGE`); the assignee moves between not started and active and into review; during
  review only the PM or Admin acts; a task with an open blocker issue cannot move forward (`409 TASK_BLOCKED`);
  a task cannot leave not started until everything it depends on is closed (`409 DEPENDENCY_NOT_DONE`);
  `completedAt` is set by approve and cleared by reopen. Request changes returns the task to the first active
  status and saves the note as a comment.
- **Dependencies** are within one project; one that would make a loop is refused (`409 DEPENDENCY_LOOP`).
- **Events:** every task change publishes an event after its transaction commits (`task.created`, `task.assigned`,
  `task.submitted`, `task.approved`, `task.due_date_changed`, ...; see `src/events/domain-events.service.ts`).
  Step 4 subscribes to them for notifications and deadline jobs; nothing is sent yet.

## Notes

- **Who can create projects:** Members need the `canManageProjects` permission, which the Workspace Admin switches on with
  `PATCH /workspaces/:id/members/:userId` and `{ "canManageProjects": true }`. In the demo data, Abel and Blien have it.
- **Time zone:** each workspace has a `timezone` (demo: Africa/Addis_Ababa). Reminders, overdue alerts and calendar weeks
  will use it.

- One table was added to the Database Design: **`sessions`**, for refresh tokens.
- **Partial indexes in `extras.sql`:** Prisma does not know about them. If a future `prisma migrate dev` generates
  a migration that tries to `DROP` `project_members_one_pm`, `sprints_one_active` or `time_entries_one_running`,
  delete those lines from the migration file before applying it.
- Emails are stored in lower case so `Blien@Company.com` and `blien@company.com` are the same account.
- **Additions to the API Design** (step 3): `GET /me/tasks` (listed in the API Design, built now), `allowedMoves` and
  `permissions` in task details, `{ "userId": null }` to unassign, `?includeManager=`, the filters listed above,
  and the new error code `409 TASK_CLOSED`.
- **Additions to the API Design** (step 2): `DELETE /projects/:projectId/teams/:teamId`, `?moveTasksTo=` on phase
  deletion, the `permissions` object in `GET /projects/:id`, and the error codes `409 PROJECT_MANAGER_REQUIRED`,
  `409 SPACE_ARCHIVED`, `409 PROJECT_ARCHIVED` and `409 STILL_TEAM_MEMBER`.
- **Open point for the notifications module:** the API Design says the PM is notified when a project is moved, but
  `notification_event` has no value for it (nor for "you are now the Project Manager"). Add one, or decide these
  are activity-log only.
- **Additions to the API Design** (step 1): `GET /spaces/:spaceId/members`, `DELETE /spaces/:spaceId/teams/:teamId`,
  `GET /teams/:teamId`, the `?keepAccess=` option on team deletion, and the error codes `409 STATUS_IN_USE`,
  `409 MEMBER_VIA_TEAM` and `409 STILL_PROJECT_MEMBER`.
- The database schema did not change in steps 1 to 3, so no new migration is needed.

## Next steps

1. ~~Spaces, workflow statuses, custom fields and teams~~ (done)
2. ~~Projects, members and phases~~ (done; the timeline, calendar and workload views come with step 5)
3. ~~Tasks, assignment suggestions and status changes~~ (done)
4. **Notifications** (in-app first, then email and SMS) and the deadline checker
5. Sprints, issues, messaging, time tracking, timeline/calendar/workload views, automations, GitHub
6. Two-factor login and password reset

