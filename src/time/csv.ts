/**
 * CSV for spreadsheets. Values that start with = + - @ are prefixed with ' so Excel or Google Sheets never treat a
 * task title or note as a formula (CSV injection).
 */
export function csvCell(value: unknown) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const toCsv = (header: string[], rows: unknown[][]) =>
  // The byte-order mark makes Excel read UTF-8 (Amharic names) correctly.
  '\uFEFF' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
