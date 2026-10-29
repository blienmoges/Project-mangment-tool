import { IssueType, PriorityLevel, SeverityLevel, StatusCategory } from '@prisma/client';

/**
 * Custom automation rules (SRS FR-15.3; API Design "Custom rules"): one trigger, conditions that must all be true, and
 * one to five actions. Plain functions: validateRule() lists every problem, matches() checks the conditions.
 */
export const TRIGGERS = ['task.created', 'task.status_changed', 'task.assigned', 'task.overdue', 'issue.created', 'pull_request.merged'] as const;
export type Trigger = (typeof TRIGGERS)[number];

export const FIELDS = ['task.priority', 'task.assigneeId', 'task.phaseId', 'task.sprintId', 'task.statusCategory', 'issue.severity', 'issue.type'] as const;
export type Field = (typeof FIELDS)[number];
export const OPERATORS = ['equals', 'not_equals', 'in', 'not_in', 'is_empty', 'is_not_empty'] as const;
export type Operator = (typeof OPERATORS)[number];

export interface Condition { field: Field; operator: Operator; value?: string | string[] }
export type Action =
  | { type: 'notify'; recipients: { assignee?: boolean; manager?: boolean; reporter?: boolean; userIds?: string[]; teamId?: string }; message: string }
  | { type: 'set_priority'; priority: PriorityLevel }
  | { type: 'move_status'; statusId: string }
  | { type: 'add_comment'; text: string };
export interface RuleDefinition { name: string; trigger: { event: Trigger; toStatusId?: string }; conditions: Condition[]; actions: Action[] }

/** What a rule may refer to in its project. */
export interface RuleContext {
  statuses: { id: string; category: StatusCategory }[];
  memberIds: string[];
  phaseIds: string[];
  sprintIds: string[];
  teamIds: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_VALUES: Partial<Record<Field, readonly string[]>> = {
  'task.priority': Object.values(PriorityLevel),
  'task.statusCategory': Object.values(StatusCategory),
  'issue.severity': Object.values(SeverityLevel),
  'issue.type': Object.values(IssueType),
};
export const PLACEHOLDERS = ['{task}', '{task.title}', '{task.shortId}', '{issue.title}', '{project}', '{rule}'];

/** Returns { fields } with one message per problem (empty when the rule is valid) and the cleaned rule. */
export function validateRule(input: unknown, ctx: RuleContext): { fields: Record<string, string>; rule?: RuleDefinition } {
  const f: Record<string, string> = {};
  const r = (input ?? {}) as Record<string, any>;
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  if (name.length < 2 || name.length > 80) f.name = 'must be 2 to 80 characters';
  const event = r.trigger?.event;
  if (!TRIGGERS.includes(event)) f['trigger.event'] = `must be one of ${TRIGGERS.join(', ')}`;
  const toStatusId = r.trigger?.toStatusId;
  if (toStatusId !== undefined) {
    if (event !== 'task.status_changed') f['trigger.toStatusId'] = 'only for task.status_changed';
    else if (!ctx.statuses.some((s) => s.id === toStatusId)) f['trigger.toStatusId'] = "must be a status of the project's space";
  }
  const conditions = Array.isArray(r.conditions) ? r.conditions : r.conditions === undefined ? [] : null;
  if (!conditions) f.conditions = 'must be a list';
  else if (conditions.length > 10) f.conditions = 'at most 10 conditions';
  (conditions ?? []).slice(0, 10).forEach((c: any, i: number) => {
    const at = `conditions.${i}`;
    if (!FIELDS.includes(c?.field)) { f[`${at}.field`] = `must be one of ${FIELDS.join(', ')}`; return; }
    if (c.field.startsWith('issue.') && event !== 'issue.created') f[`${at}.field`] = 'issue fields need the issue.created trigger';
    if (!OPERATORS.includes(c.operator)) { f[`${at}.operator`] = `must be one of ${OPERATORS.join(', ')}`; return; }
    if (c.operator === 'is_empty' || c.operator === 'is_not_empty') return;
    const values: unknown[] = c.operator === 'in' || c.operator === 'not_in' ? (Array.isArray(c.value) && c.value.length ? c.value : [undefined]) : [c.value];
    if ((c.operator === 'in' || c.operator === 'not_in') && !Array.isArray(c.value)) { f[`${at}.value`] = 'must be a list for in / not_in'; return; }
    const known = (v: unknown) => {
      const allowed = ALLOWED_VALUES[c.field as Field];
      if (allowed) return allowed.includes(v as string);
      if (typeof v !== 'string' || !UUID.test(v)) return false;
      return c.field === 'task.assigneeId' ? ctx.memberIds.includes(v) : c.field === 'task.phaseId' ? ctx.phaseIds.includes(v) : ctx.sprintIds.includes(v);
    };
    if (!values.every(known)) f[`${at}.value`] = ALLOWED_VALUES[c.field as Field] ? `must be ${ALLOWED_VALUES[c.field as Field]!.join(', ')}` : `must be ${c.field === 'task.assigneeId' ? 'a project member' : c.field === 'task.phaseId' ? 'a phase' : 'a sprint'} of this project`;
  });
  const actions = Array.isArray(r.actions) ? r.actions : [];
  if (!actions.length || actions.length > 5) f.actions = 'must have 1 to 5 actions';
  actions.slice(0, 5).forEach((a: any, i: number) => {
    const at = `actions.${i}`;
    switch (a?.type) {
      case 'notify': {
        const to = a.recipients ?? {};
        const any = to.assignee || to.manager || to.reporter || (Array.isArray(to.userIds) && to.userIds.length) || to.teamId;
        if (!any) f[`${at}.recipients`] = 'choose at least one: assignee, manager, reporter, userIds or teamId';
        if (to.reporter && event !== 'issue.created') f[`${at}.recipients`] = 'reporter needs the issue.created trigger';
        if (to.userIds !== undefined && (!Array.isArray(to.userIds) || to.userIds.length > 20 || !to.userIds.every((u: unknown) => typeof u === 'string' && ctx.memberIds.includes(u)))) f[`${at}.recipients.userIds`] = 'must be up to 20 members of this project';
        if (to.teamId !== undefined && !ctx.teamIds.includes(to.teamId)) f[`${at}.recipients.teamId`] = 'must be a team of this workspace';
        if (typeof a.message !== 'string' || !a.message.trim() || a.message.length > 500) f[`${at}.message`] = `must be 1 to 500 characters; you can use ${PLACEHOLDERS.join(' ')}`;
        break;
      }
      case 'set_priority':
        if (!Object.values(PriorityLevel).includes(a.priority)) f[`${at}.priority`] = `must be ${Object.values(PriorityLevel).join(', ')}`;
        break;
      case 'move_status': {
        const s = ctx.statuses.find((x) => x.id === a.statusId);
        if (!s) f[`${at}.statusId`] = "must be a status of the project's space";
        else if (s.category === StatusCategory.closed) f[`${at}.statusId`] = 'cannot be a closed status: only the Project Manager closes tasks, by approving them';
        break;
      }
      case 'add_comment':
        if (typeof a.text !== 'string' || !a.text.trim() || a.text.length > 2000) f[`${at}.text`] = 'must be 1 to 2000 characters';
        break;
      default:
        f[`${at}.type`] = 'must be notify, set_priority, move_status or add_comment';
    }
  });
  if (Object.keys(f).length) return { fields: f };
  return {
    fields: {},
    rule: {
      name, trigger: { event, ...(toStatusId ? { toStatusId } : {}) },
      conditions: (conditions ?? []).map((c: any) => ({ field: c.field, operator: c.operator, ...(c.value !== undefined ? { value: c.value } : {}) })),
      actions: actions.map((a: any) => {
        if (a.type === 'notify') {
          const t = a.recipients;
          return { type: 'notify', message: a.message.trim(), recipients: { ...(t.assignee ? { assignee: true } : {}), ...(t.manager ? { manager: true } : {}), ...(t.reporter ? { reporter: true } : {}), ...(t.userIds?.length ? { userIds: t.userIds } : {}), ...(t.teamId ? { teamId: t.teamId } : {}) } };
        }
        if (a.type === 'set_priority') return { type: a.type, priority: a.priority };
        if (a.type === 'move_status') return { type: a.type, statusId: a.statusId };
        return { type: 'add_comment', text: a.text.trim() };
      }),
    },
  };
}

/** The values a rule's conditions are checked against. */
export type Facts = Partial<Record<Field, string | null>>;

export function matches(conditions: Condition[], facts: Facts) {
  return conditions.every((c) => {
    const v = facts[c.field] ?? null;
    switch (c.operator) {
      case 'equals': return v === c.value;
      case 'not_equals': return v !== c.value;
      case 'in': return v !== null && (c.value as string[]).includes(v);
      case 'not_in': return v === null || !(c.value as string[]).includes(v);
      case 'is_empty': return v === null;
      case 'is_not_empty': return v !== null;
      default: return false;
    }
  });
}

/** Fills {task}, {task.title}, {task.shortId}, {issue.title}, {project} and {rule} in a message. */
export function render(text: string, values: { taskShortId?: string; taskTitle?: string; issueTitle?: string; project?: string; rule: string }) {
  return text
    .replace(/\{task\}/g, values.taskShortId && values.taskTitle ? `${values.taskShortId} ${values.taskTitle}` : values.taskShortId ?? '')
    .replace(/\{task\.title\}/g, values.taskTitle ?? '')
    .replace(/\{task\.shortId\}/g, values.taskShortId ?? '')
    .replace(/\{issue\.title\}/g, values.issueTitle ?? '')
    .replace(/\{project\}/g, values.project ?? '')
    .replace(/\{rule\}/g, values.rule)
    .slice(0, 1000);
}
