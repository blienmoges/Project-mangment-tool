/**
 * Sprint arithmetic (API Design: "Sprints", "Sprint capacity"; Database Design: "Burndown"), as plain functions.
 * Dates are "YYYY-MM-DD" strings in the workspace's time zone; weekdays use ISO numbers (Monday = 1 ... Sunday = 7).
 */
import { addDays } from '../jobs/timing';

/** FR-12.1: two weeks by default, counting the start day (Monday → the Sunday 13 days later). */
export const DEFAULT_SPRINT_DAYS = 14;
export const defaultEndDate = (start: string) => addDays(start, DEFAULT_SPRINT_DAYS - 1);

export function eachDay(start: string, end: string) {
  const days: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  return days;
}

export const isoWeekday = (date: string) => {
  const w = new Date(`${date}T00:00:00Z`).getUTCDay();
  return w === 0 ? 7 : w;
};

export const workingDaysIn = (start: string, end: string, workingDays: number[]) =>
  eachDay(start, end).filter((d) => workingDays.includes(isoWeekday(d))).length;

export interface BurndownTask {
  points: number;
  /** Local date the task was completed, or null if still open. */
  doneOn: string | null;
}

/**
 * For each sprint day: story points not yet completed at the end of that day (null for days still to come), and the
 * ideal line falling evenly from the total on the first day to 0 on the last.
 */
export function burndown(start: string, end: string, today: string, tasks: BurndownTask[]) {
  const days = eachDay(start, end);
  const total = tasks.reduce((s, t) => s + t.points, 0);
  const steps = Math.max(1, days.length - 1);
  return {
    totalPoints: total,
    days: days.map((date, i) => ({
      date,
      remaining: date > today ? null : tasks.filter((t) => !t.doneOn || t.doneOn > date).reduce((s, t) => s + t.points, 0),
      ideal: Math.round((total - (total * i) / steps) * 10) / 10,
    })),
  };
}

/** over when planned is more than capacity, near at 90% or more, otherwise ok. */
export function capacityStatus(planned: number, capacity: number): 'ok' | 'near' | 'over' {
  if (planned > capacity) return 'over';
  if (capacity > 0 && planned >= 0.9 * capacity) return 'near';
  return 'ok';
}

/** One person's hours for the sprint: weekly capacity × sprint working days ÷ working days per week, minus other work. */
export function personCapacityHours(weeklyHours: number, sprintWorkingDays: number, workingDaysPerWeek: number, otherProjectHours: number) {
  const base = workingDaysPerWeek > 0 ? (weeklyHours * sprintWorkingDays) / workingDaysPerWeek : 0;
  return Math.max(0, Math.round((base - otherProjectHours) * 10) / 10);
}
