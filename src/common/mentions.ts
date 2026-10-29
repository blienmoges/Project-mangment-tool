/**
 * @mentions (SRS FR-5.4). The app writes a mention as  @[Meron Alemu](<userId>)  when someone picks a person,
 * so the server can find the people by id even if names repeat or change. The visible name is only for display.
 */
const MENTION = /@\[([^\]\n]{1,120})\]\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi;

/** The distinct user ids mentioned in a text, in order of first appearance. */
export function mentionedIds(text: string): string[] {
  const ids: string[] = [];
  for (const m of text.matchAll(MENTION)) {
    const id = m[2].toLowerCase();
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** The text with mentions shown as "@Name" (for notifications, email and SMS). */
export const plainText = (text: string) => text.replace(MENTION, (_all, name: string) => `@${name}`);

/** Short preview for notifications and channel lists. */
export function preview(text: string, max = 120) {
  const t = plainText(text).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}
