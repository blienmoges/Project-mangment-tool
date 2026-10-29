/**
 * Calendar periods and workload spreading (API Design: "Calendar views", workload view; Database Design: "Workload").
 * Dates are "YYYY-MM-DD" in the workspace time zone; weekdays are ISO (Monday = 1).
 */
import { addDays } from '../jobs/timing';
import { eachDay, isoWeekday } from '../sprints/sprint-math';

export const mondayOf = (date: string) => addDays(date, 1 - isoWeekday(date));

/** week: Monday to Sunday around `date`; month: whole weeks covering the month, for a full calendar grid. */
export function calendarPeriod(view: 'month' | 'week', date: string) {
  if (view === 'week') { const start = mondayOf(date); return { start, end: addDays(start, 6) }; }
  const first = `${date.slice(0, 7)}-01`;
  const nextMonth = new Date(`${first}T00:00:00Z`);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const last = addDays(nextMonth.toISOString().slice(0, 10), -1);
  return { start: mondayOf(first), end: addDays(mondayOf(last), 6) };
}

export interface OpenTask {
  hours: number;
  startDate: string | null;
  dueDate: string | null;
}

/**
 * Spreads a task's estimated hours evenly over the working days from max(today, start date) to its due date.
 * Overdue tasks count fully today; tasks without a due date are returned as "unscheduled".
 * Returns hours per day ("YYYY-MM-DD" → hours).
 */
export function spreadHours(task: OpenTask, today: string, workingDays: number[]): { perDay: Map<string, number>; unscheduled: number } {
  const perDay = new Map<string, number>();
  if (!task.hours) return { perDay, unscheduled: 0 };
  if (!task.dueDate) return { perDay, unscheduled: task.hours };
  if (task.dueDate < today) { perDay.set(today, task.hours); return { perDay, unscheduled: 0 }; }
  const from = task.startDate && task.startDate > today ? task.startDate : today;
  let days = eachDay(from, task.dueDate).filter((d) => workingDays.includes(isoWeekday(d)));
  if (!days.length) days = [task.dueDate]; // due on a weekend with no working day left: all on the due date
  for (const d of days) perDay.set(d, task.hours / days.length);
  return { perDay, unscheduled: 0 };
}

/** Capacity of one week: weekly hours × the week's working days still ahead (from today) ÷ working days per week. */
export function weekCapacity(weeklyHours: number, weekStart: string, today: string, workingDays: number[]) {
  const ahead = eachDay(weekStart, addDays(weekStart, 6)).filter((d) => d >= today && workingDays.includes(isoWeekday(d))).length;
  return workingDays.length ? Math.round(((weeklyHours * ahead) / workingDays.length) * 10) / 10 : 0;
}

export const loadStatus = (hours: number, capacity: number): 'ok' | 'near' | 'over' =>
  hours > capacity ? 'over' : capacity > 0 && hours >= 0.85 * capacity ? 'near' : 'ok';
