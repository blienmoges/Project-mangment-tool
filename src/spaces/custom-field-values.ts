import { CustomField, FieldType } from '@prisma/client';

export interface DropdownOption {
  id: string;
  label: string;
  color?: string;
}

export function dropdownOptions(field: Pick<CustomField, 'options'>): DropdownOption[] {
  return Array.isArray(field.options) ? (field.options as unknown as DropdownOption[]) : [];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Checks a task's value for a custom field (used by the tasks module, step 3).
 * Returns an error message, or null when the value is valid. `null` itself means "clear the value".
 * Stored values: text → string, number → number, checkbox → boolean, date → "YYYY-MM-DD", dropdown → option id.
 */
export function checkFieldValue(field: Pick<CustomField, 'fieldType' | 'options'>, value: unknown): string | null {
  if (value === null) return null;
  switch (field.fieldType) {
    case FieldType.text:
      return typeof value === 'string' && value.length <= 2000 ? null : 'must be text of at most 2000 characters';
    case FieldType.number:
      return typeof value === 'number' && Number.isFinite(value) ? null : 'must be a number';
    case FieldType.checkbox:
      return typeof value === 'boolean' ? null : 'must be true or false';
    case FieldType.date:
      return typeof value === 'string' && ISO_DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? null : 'must be a date such as 2027-02-26';
    case FieldType.dropdown:
      return typeof value === 'string' && dropdownOptions(field).some((o) => o.id === value) ? null : "must be the id of one of the field's choices";
    default:
      return 'unknown field type';
  }
}
