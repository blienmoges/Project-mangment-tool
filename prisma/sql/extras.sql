-- ===== extras.sql: database rules Prisma cannot describe in schema.prisma =====
-- Added to the first migration by `npm run db:add-extras` (see README).

-- One Project Manager per project
CREATE UNIQUE INDEX project_members_one_pm ON project_members (project_id) WHERE role = 'project_manager';
-- One active sprint per project
CREATE UNIQUE INDEX sprints_one_active ON sprints (project_id) WHERE state = 'active';
-- One running timer per person
CREATE UNIQUE INDEX time_entries_one_running ON time_entries (user_id) WHERE ended_at IS NULL;

-- CHECK constraints
ALTER TABLE projects ADD CONSTRAINT projects_dates_check CHECK (end_date > start_date);
ALTER TABLE sprints ADD CONSTRAINT sprints_dates_check CHECK (end_date > start_date);
ALTER TABLE tasks ADD CONSTRAINT tasks_dates_check CHECK (due_date IS NULL OR start_date IS NULL OR due_date >= start_date);
ALTER TABLE tasks ADD CONSTRAINT tasks_estimate_check CHECK (estimated_hours IS NULL OR estimated_hours >= 0);
ALTER TABLE tasks ADD CONSTRAINT tasks_points_check CHECK (story_points IS NULL OR story_points >= 0);
ALTER TABLE task_dependencies ADD CONSTRAINT task_dependencies_not_self CHECK (task_id <> depends_on_task_id);
ALTER TABLE attachments ADD CONSTRAINT attachments_one_owner CHECK (num_nonnulls(task_id, issue_id, message_id) = 1);
ALTER TABLE attachments ADD CONSTRAINT attachments_max_size CHECK (size_bytes <= 20971520);
ALTER TABLE time_entries ADD CONSTRAINT time_entries_minutes_check CHECK (minutes IS NULL OR minutes > 0);
ALTER TABLE channels ADD CONSTRAINT channels_type_check CHECK (
  (type = 'direct'  AND project_id IS NULL     AND team_id IS NULL) OR
  (type = 'project' AND project_id IS NOT NULL AND team_id IS NULL) OR
  (type = 'team'    AND team_id IS NOT NULL    AND project_id IS NULL)
);

-- Message search: make search_vector a generated column with a GIN index
ALTER TABLE messages DROP COLUMN IF EXISTS search_vector;
ALTER TABLE messages ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(body, ''))) STORED;
CREATE INDEX messages_search ON messages USING GIN (search_vector);

