import { SkillLevel } from '@prisma/client';

/**
 * Assignee ranking (API Design, "How suggestions are ranked"; SRS FR-3.2, FR-3.3).
 * Pure functions: the service loads the data, this file does the arithmetic.
 */

export const LEVEL: Record<SkillLevel, number> = { beginner: 1, intermediate: 2, expert: 3 };
const LABEL: Record<SkillLevel, string> = { beginner: 'Beginner', intermediate: 'Intermediate', expert: 'Expert' };

export interface RequiredSkill {
  skillId: string;
  name: string;
  minLevel: SkillLevel;
}

export interface Candidate {
  user: { id: string; fullName: string; avatarUrl: string | null; jobTitle: string | null };
  capacityHours: number;
  openHours: number;
  openTasks: number;
  skills: Map<string, { level: SkillLevel; verified: boolean }>;
  isCurrentAssignee: boolean;
}

/** Score for one required skill: 1.0 at or above the minimum, 0.6 × (level ÷ minimum) below it, 0 without it. */
export function skillScore(has: SkillLevel | undefined, min: SkillLevel) {
  if (!has) return 0;
  return LEVEL[has] >= LEVEL[min] ? 1 : 0.6 * (LEVEL[has] / LEVEL[min]);
}

export function evaluate(c: Candidate, required: RequiredSkill[]) {
  const matched: string[] = [];
  const partial: string[] = [];
  const missing: string[] = [];
  let verifiedMatched = 0;
  let total = 0;
  for (const r of required) {
    const has = c.skills.get(r.skillId);
    const s = skillScore(has?.level, r.minLevel);
    total += s;
    if (!has) missing.push(`${r.name} · ${LABEL[r.minLevel]}`);
    else if (s === 1) {
      matched.push(`${r.name} · ${LABEL[has.level]}`);
      if (has.verified) verifiedMatched += 1;
    } else partial.push(`${r.name} · ${LABEL[has.level]} (needs ${LABEL[r.minLevel]})`);
  }
  const skillMatch = required.length ? Math.round((total / required.length) * 100) : 100;
  const load = c.capacityHours > 0 ? (c.openHours / c.capacityHours) * 100 : 100;
  const score = 0.75 * skillMatch + 0.25 * Math.max(0, 100 - load);
  return {
    user: c.user,
    score: Math.round(score * 10) / 10,
    skillMatch,
    matchedSkills: matched,
    partialSkills: partial,
    missingSkills: missing,
    verifiedMatched,
    workloadHours: Math.round(c.openHours * 100) / 100,
    openTasks: c.openTasks,
    capacityHours: c.capacityHours,
    loadPercent: Math.round(load),
    nearCapacity: load >= 85,
    overCapacity: load > 100,
    isCurrentAssignee: c.isCurrentAssignee,
    exactScore: score,
  };
}

/** Best first. Ties: higher skillMatch, fewer open hours, more verified matched skills, name A to Z. */
export function rank(candidates: Candidate[], required: RequiredSkill[], limit = 10) {
  return candidates
    .map((c) => evaluate(c, required))
    .sort(
      (a, b) =>
        b.exactScore - a.exactScore ||
        b.skillMatch - a.skillMatch ||
        a.workloadHours - b.workloadHours ||
        b.verifiedMatched - a.verifiedMatched ||
        a.user.fullName.localeCompare(b.user.fullName),
    )
    .slice(0, limit)
    .map(({ exactScore, ...r }, i) => ({ ...r, rank: i + 1 }));
}
