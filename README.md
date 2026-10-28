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


