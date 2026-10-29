import { Injectable, Logger } from '@nestjs/common';

export type TaskEventType =
  | 'task.created'
  | 'task.updated'
  | 'task.due_date_changed'
  | 'task.deleted'
  | 'task.assigned'
  | 'task.unassigned'
  | 'task.accepted'
  | 'task.concern'
  | 'task.status_changed'
  | 'task.submitted'
  | 'task.approved'
  | 'task.changes_requested'
  | 'task.reopened';

export interface DomainEvent {
  type: TaskEventType;
  workspaceId: string;
  projectId: string;
  taskId: string;
  actorId: string;
  /** Event details, for example { fromStatusId, toStatusId } or { assigneeId, previousAssigneeId }. */
  data?: Record<string, unknown>;
}

type Handler = (event: DomainEvent) => Promise<void> | void;

/**
 * A small in-process event bus. Services emit events after their database transaction has committed;
 * the notifications, deadline-job and automation modules subscribe with `on()`. A failing handler is logged
 * and never breaks the request that caused the event.
 */
@Injectable()
export class DomainEventsService {
  private readonly logger = new Logger('DomainEvents');
  private readonly handlers = new Map<string, Handler[]>();

  /** Subscribe to one event type, or to every event with '*'. */
  on(type: TaskEventType | '*', handler: Handler) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
  }

  emit(event: DomainEvent) {
    const handlers = [...(this.handlers.get(event.type) ?? []), ...(this.handlers.get('*') ?? [])];
    for (const handler of handlers) {
      setImmediate(async () => {
        try {
          await handler(event);
        } catch (e) {
          this.logger.error(`Handler for ${event.type} failed: ${e instanceof Error ? e.stack : String(e)}`);
        }
      });
    }
  }
}
