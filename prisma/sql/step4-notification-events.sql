-- Step 4: new notification event types. `npx prisma migrate dev --name notification_events --create-only`
-- should generate exactly these lines (see README, "Updating an existing database").
ALTER TYPE "notification_event" ADD VALUE 'task_accepted';
ALTER TYPE "notification_event" ADD VALUE 'task_concern';
ALTER TYPE "notification_event" ADD VALUE 'review_requested';
ALTER TYPE "notification_event" ADD VALUE 'task_approved';
ALTER TYPE "notification_event" ADD VALUE 'changes_requested';
ALTER TYPE "notification_event" ADD VALUE 'task_reopened';
ALTER TYPE "notification_event" ADD VALUE 'due_date_changed';
ALTER TYPE "notification_event" ADD VALUE 'ready_to_start';
ALTER TYPE "notification_event" ADD VALUE 'phase_overdue';
ALTER TYPE "notification_event" ADD VALUE 'added_to_project';
ALTER TYPE "notification_event" ADD VALUE 'made_manager';
ALTER TYPE "notification_event" ADD VALUE 'project_moved';
ALTER TYPE "notification_event" ADD VALUE 'member_removed';
