import { IssueStatus as S } from '@prisma/client';
import { AppException, Errors } from '../common/app-exception';

/**
 * Issue statuses (SRS FR-6.4): open → in_progress → resolved → closed, with the way back to open.
 * The reporter, the person fixing it, the PM and the Admin can move an issue; closing it and reopening a closed one
 * are for the PM and Admin (the SRS lists "close issues" among the Project Manager's permissions).
 */
export interface IssueActor {
  isManager: boolean;
  isReporter: boolean;
  isFixer: boolean;
}

const ALLOWED: Record<S, S[]> = {
  open: [S.in_progress, S.resolved, S.closed],
  in_progress: [S.open, S.resolved, S.closed],
  resolved: [S.open, S.in_progress, S.closed],
  closed: [S.open],
};

export function checkIssueMove(from: S, to: S, actor: IssueActor): AppException | null {
  if (!actor.isManager && !actor.isReporter && !actor.isFixer) {
    return Errors.forbidden('Only the reporter, the person fixing it or the Project Manager can change this issue.');
  }
  if (!ALLOWED[from].includes(to)) {
    return Errors.conflict('INVALID_STATUS_CHANGE', `An issue cannot move from ${from.replace('_', ' ')} to ${to.replace('_', ' ')}.`);
  }
  if ((to === S.closed || from === S.closed) && !actor.isManager) {
    return Errors.forbidden('Only the Project Manager can close an issue or reopen a closed one.');
  }
  return null;
}

/** Open and in-progress issues are "open": they count on the dashboard and, as blockers, block their task. */
export const OPEN_ISSUE_STATUSES: S[] = [S.open, S.in_progress];
