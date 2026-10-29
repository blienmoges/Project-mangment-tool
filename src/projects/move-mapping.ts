import { CustomField, FieldType, StatusCategory, WorkflowStatus } from '@prisma/client';
import { dropdownOptions } from '../spaces/custom-field-values';

const isClosed = (s: Pick<WorkflowStatus, 'category'>) => s.category === StatusCategory.closed;

/**
 * Maps each status of the old space to one of the new space (API Design, "Move a project", rule 2):
 * first `explicit` (statusMapping), then a status with the same name, then the first status of the same category.
 * A closed status always maps to a closed one and an open one to an open one, so tasks that were closed stay closed
 * and nothing is closed without approval. Returns field errors for VALIDATION_FAILED when the mapping is invalid.
 */
export function mapStatuses(source: WorkflowStatus[], target: WorkflowStatus[], explicit: Record<string, unknown> = {}) {
  const map = new Map<string, WorkflowStatus>();
  const errors: Record<string, string> = {};
  const byPosition = [...target].sort((a, b) => a.position - b.position);
  for (const key of Object.keys(explicit)) {
    if (!source.some((s) => s.id === key)) errors[`statusMapping.${key}`] = "is not a status of the project's current space";
  }
  for (const s of source) {
    const wanted = explicit[s.id];
    if (wanted !== undefined) {
      const t = target.find((x) => x.id === wanted);
      if (!t) errors[`statusMapping.${s.id}`] = 'must be a status of the target space';
      else if (isClosed(t) !== isClosed(s)) errors[`statusMapping.${s.id}`] = 'a closed status must map to a closed status, and an open one to an open one';
      else map.set(s.id, t);
      continue;
    }
    const sameName = target.find((t) => t.name.toLowerCase() === s.name.toLowerCase() && isClosed(t) === isClosed(s));
    const sameCategory = byPosition.find((t) => t.category === s.category);
    const chosen = sameName ?? sameCategory;
    if (chosen) map.set(s.id, chosen);
    else errors[`statusMapping.${s.id}`] = `the target space has no ${s.category} status; map "${s.name}" explicitly`;
  }
  return { map, errors };
}

export interface FieldMatch {
  target: CustomField | null;
  /** For dropdown fields: old choice id → new choice id (choices are matched by label). */
  options: Map<string, string>;
}

/** Custom fields are carried over when the new space has a field with the same name and type (rule 3). */
export function mapFields(source: CustomField[], target: CustomField[]) {
  const result = new Map<string, FieldMatch>();
  for (const f of source) {
    const t = target.find((x) => x.name.toLowerCase() === f.name.toLowerCase() && x.fieldType === f.fieldType) ?? null;
    const options = new Map<string, string>();
    if (t && f.fieldType === FieldType.dropdown) {
      const targetOptions = dropdownOptions(t);
      for (const o of dropdownOptions(f)) {
        const match = targetOptions.find((x) => x.label.toLowerCase() === o.label.toLowerCase());
        if (match) options.set(o.id, match.id);
      }
    }
    result.set(f.id, { target: t, options });
  }
  return result;
}
