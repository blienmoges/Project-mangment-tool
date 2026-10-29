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

d
