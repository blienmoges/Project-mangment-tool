import { StatusCategory } from '@prisma/client';

/**
 * The task workflow rules from the API Design ("Workflow rules"), as pure functions so they can be tested alone.
 * Statuses are kept in category order (Not started → Active → Review → Closed), so a higher position is "later".
 */

export interface StatusRef {
  id: string;
  name: string;
  category: StatusCategory;
  position: number;
}

export interface MoveContext {
  from: StatusRef;
  /** The Project Manager or a Workspace Admin. */
  isManager: boolean;
  isAssignee: boolean;
  /** An open blocker issue is linked to the task. */
  blocked: boolean;
  /** Every task it depends on is closed. */
  dependenciesDone: boolean;
}

export interface RuleError {
  status: 403 | 409 | 400;
  code: string;
  message: string;
}

const err = (status: RuleError['status'], code: string, message: string): RuleError => ({ status, code, message });

/** Shared checks for any move that is allowed by role: blocked tasks and unfinished dependencies (rules 5 and 6). */
function progressChecks(ctx: MoveContext, to: StatusRef): RuleError | null {
  const forward = to.position > ctx.from.position;
  if (ctx.blocked && forward) {
    return err(409, 'TASK_BLOCKED', 'This task is blocked by an open blocker issue. It can move back, but not forward, until the issue is resolved.');
  }
  if (ctx.from.category === StatusCategory.not_started && to.category !== StatusCategory.not_started && !ctx.dependenciesDone) {
    return err(409, 'DEPENDENCY_NOT_DONE', 'This task cannot start until every task it depends on is done.');
  }
  return null;
}

/** POST /tasks/:id/status (and /submit, which moves to the first review status). */
export function checkStatusMove(ctx: MoveContext, to: StatusRef): RuleError | null {
  if (to.category === StatusCategory.closed) {
    return err(403, 'APPROVAL_REQUIRED', 'Only the Project Manager can close a task, by approving it.');
  }
  if (ctx.from.category === StatusCategory.closed) {
    return err(409, 'INVALID_STATUS_CHANGE', 'This task is finished. The Project Manager can reopen it.');
  }
  if (!ctx.isManager) {
    if (!ctx.isAssignee) return err(403, 'FORBIDDEN', 'Only the assignee or the Project Manager can move this task.');
    if (ctx.from.category === StatusCategory.review) {
      return err(403, 'FORBIDDEN', 'While a task is in review, only the Project Manager can approve it or request changes.');
    }
  }
  return progressChecks(ctx, to);
}

/** POST /tasks/:id/approve — `to` must be a closed status. */
export function checkApprove(ctx: MoveContext, to: StatusRef): RuleError | null {
  if (!ctx.isManager) return err(403, 'FORBIDDEN', 'Only the Project Manager can approve tasks.');
  if (ctx.from.category !== StatusCategory.review) {
    return err(409, 'INVALID_STATUS_CHANGE', 'Only a task in review can be approved. It has to be submitted for review first.');
  }
  if (to.category !== StatusCategory.closed) return err(400, 'VALIDATION_FAILED', 'statusId must be a closed status, such as Done.');
  return progressChecks(ctx, to);
}

/** POST /tasks/:id/request-changes — back to a not-started or active status. */
export function checkRequestChanges(ctx: MoveContext, to: StatusRef): RuleError | null {
  if (!ctx.isManager) return err(403, 'FORBIDDEN', 'Only the Project Manager can request changes.');
  if (ctx.from.category !== StatusCategory.review) return err(409, 'INVALID_STATUS_CHANGE', 'Changes can only be requested for a task in review.');
  if (to.category !== StatusCategory.active && to.category !== StatusCategory.not_started) {
    return err(400, 'VALIDATION_FAILED', 'statusId must be a not-started or active status.');
  }
  return null;
}

/** POST /tasks/:id/reopen — from closed back to a not-started or active status. */
export function checkReopen(ctx: MoveContext, to: StatusRef): RuleError | null {
  if (!ctx.isManager) return err(403, 'FORBIDDEN', 'Only the Project Manager can reopen tasks.');
  if (ctx.from.category !== StatusCategory.closed) return err(409, 'INVALID_STATUS_CHANGE', 'Only a finished task can be reopened.');
  if (to.category !== StatusCategory.active && to.category !== StatusCategory.not_started) {
    return err(400, 'VALIDATION_FAILED', 'statusId must be a not-started or active status.');
  }
  return null;
}

/** First status of a category in workflow order (statuses must be sorted by position). */
export const firstOf = <T extends StatusRef>(statuses: T[], category: StatusCategory) => statuses.find((s) => s.category === category);
