import { SkillLevel } from '@prisma/client';

/**
 * Assignee ranking from the API Design ("How suggestions are ranked"), as a pure function.
 *  skillMatch  = average per-skill score × 100 (1.0 at/above the minimum, 0.6 × level/minimum below it, 0 without it)
 *  loadPercent = open estimated hours ÷ weekly capacity × 100
 *  score       = 0.75 × skillMatch + 0.25 × max(0, 100 − loadPercent)
 * Ties: higher skillMatch, fewer open hours, more verified matched skills, name A to Z.
 */

export const LEVEL_VALUE: Record<SkillLevel, number> = { beginner: 1, intermediate: 2, expert: 3 };
export const LEVEL_LABEL: Record<SkillLevel, string> = { beginner: 'Beginner', intermediate: 'Intermediate', expert: 'Expert' };

export interface RequiredSkill {
  skillId: string;
  name: string;
  minLevel: SkillLevel;
}

export interface CandidateSkill {
  skillId: string;
  level: SkillLevel;
  verified: boolean;
}

export interface Candidate {
  id: string;
  fullName: string;
  openHours: number;
  capacityHours: number;
  skills: CandidateSkill[];
}

export interface Suggestion {
  userId: string;
  fullName: string;
  skillMatch: number;
  /** Skills at or above the minimum, e.g. "Node.js · Expert". */
  matchedSkills: string[];
  /** Skills the person has below the minimum, e.g. "Redis · Beginner (needs Intermediate)". */
  belowLevelSkills: string[];
  /** Required skills the person does not have. */
  missingSkills: string[];
  verifiedMatched: number;
  workloadHours: number;
  capacityHours: number;
  loadPercent: number;
  score: number;
  nearCapacity: boolean;
  overCapacity: boolean;
  rank: number;
}

export function skillScore(level: SkillLevel | undefined, minLevel: SkillLevel) {
  if (!level) return 0;
  const have = LEVEL_VALUE[level];
  const need = LEVEL_VALUE[minLevel];
  return have >= need ? 1 : 0.6 * (have / need);
}

export function rankCandidates(required: RequiredSkill[], candidates: Candidate[]): Suggestion[] {
  const scored = candidates.map((c) => {
    const matchedSkills: string[] = [];
    const belowLevelSkills: string[] = [];
    const missingSkills: string[] = [];
    let total = 0;
    let verifiedMatched = 0;
    for (const r of required) {
      const has = c.skills.find((s) => s.skillId === r.skillId);
      total += skillScore(has?.level, r.minLevel);
      if (!has) missingSkills.push(r.name);
      else if (LEVEL_VALUE[has.level] >= LEVEL_VALUE[r.minLevel]) {
        matchedSkills.push(`${r.name} · ${LEVEL_LABEL[has.level]}`);
        if (has.verified) verifiedMatched += 1;
      } else belowLevelSkills.push(`${r.name} · ${LEVEL_LABEL[has.level]} (needs ${LEVEL_LABEL[r.minLevel]})`);
    }
    const skillMatch = required.length ? Math.round((total / required.length) * 100) : 100;
    const loadPercent = c.capacityHours > 0 ? Math.round((c.openHours / c.capacityHours) * 100) : 0;
    const score = Math.round((0.75 * skillMatch + 0.25 * Math.max(0, 100 - loadPercent)) * 10) / 10;
    return {
      userId: c.id,
      fullName: c.fullName,
      skillMatch,
      matchedSkills,
      belowLevelSkills,
      missingSkills,
      verifiedMatched,
      workloadHours: Math.round(c.openHours * 100) / 100,
      capacityHours: c.capacityHours,
      loadPercent,
      score,
      nearCapacity: loadPercent >= 85,
      overCapacity: loadPercent > 100,
      rank: 0,
    };
  });
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.skillMatch - a.skillMatch ||
      a.workloadHours - b.workloadHours ||
      b.verifiedMatched - a.verifiedMatched ||
      a.fullName.localeCompare(b.fullName),
  );
  scored.forEach((s, i) => (s.rank = i + 1));
  return scored;
}
