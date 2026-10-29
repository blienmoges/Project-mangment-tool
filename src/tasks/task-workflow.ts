import { StatusCategory as C } from '@prisma/client';
import { AppException, Errors } from '../common/app-exception';

/**
 * The API Design's workflow rules (section 5, "Workflow rules"), as plain functions so they can be tested alone.
 * Each check returns the error to throw, or null when the change is allowed.
 */

export interface StatusLike {
  id: string;
  name: string;
  category: C;
  position: number;
}

export interface Actor {
  /** Workspace Admin or the project's PM. */
  isManager: boolean;
  isAssignee: boolean;
}

/** Rules 1–4: who may use POST /status (and /submit) for this move. */
export function checkMove(from: StatusLike, to: StatusLike, actor: Actor): AppException | null {
  if (to.category === C.closed) {
    return Errors.forbiddenCode('APPROVAL_REQUIRED', 'Only the Project Manager can close a task, by approving it after review.');
  }
  if (from.category === C.closed) {
    return Errors.conflict('INVALID_STATUS_CHANGE', 'This task is finished. The Project Manager can reopen it.');
  }
  if (from.category === C.review && !actor.isManager) {
    return Errors.forbidden('While a task is in review, only the Project Manager can change it: approve it or request changes.');
  }
  if (!actor.isManager && !actor.isAssignee) {
    return Errors.forbidden("Only the task's assignee or the Project Manager can move it.");
  }
  return null;
}

/**
 * Rules 5 and 6, for everyone including the PM:
 *  - a blocked task (open blocker issue) cannot move forward or into review; moving back is allowed;
 *  - a task cannot leave Not started while a task it depends on is unfinished.
 */
export function checkProgress(from: StatusLike, to: StatusLike, state: { blocked: boolean; unfinishedDependencies: number }): AppException | null {
  const forward = to.position > from.position || (to.category === C.review && from.category !== C.review) || to.category === C.closed;
  if (state.blocked && forward) {
    return Errors.conflict('TASK_BLOCKED', 'This task is blocked by an open blocker issue. It can move forward again once the issue is resolved.');
  }
  if (from.category === C.not_started && to.category !== C.not_started && state.unfinishedDependencies > 0) {
    return Errors.conflict(
      'DEPENDENCY_NOT_DONE',
      `This task depends on ${state.unfinishedDependencies} task(s) that are not finished yet, so it cannot start.`,
    );
  }
  return null;
}

/** First status of a category in board order (the default target of submit, approve, request changes, reopen). */
export function firstOf<T extends StatusLike>(statuses: T[], category: C): T | undefined {
  return [...statuses].sort((a, b) => a.position - b.position).find((s) => s.category === category);
}

/** The statuses POST /status would accept for this caller, so the app can offer only valid moves. */
export function allowedTargets(statuses: StatusLike[], from: StatusLike, actor: Actor, state: { blocked: boolean; unfinishedDependencies: number }) {
  return statuses.filter((to) => to.id !== from.id && !checkMove(from, to, actor) && !checkProgress(from, to, state)).map((s) => s.id);
}
