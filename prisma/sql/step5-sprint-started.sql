-- Step 5: one new notification event type. `npx prisma migrate dev --name sprint_started --create-only`
-- should generate exactly this line (see README, "Updating an existing database").
ALTER TYPE "notification_event" ADD VALUE 'sprint_started';
