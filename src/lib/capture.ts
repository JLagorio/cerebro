import { INBOX_DIR } from '@/engine/inbox';
import { slugify } from '@/lib/slug';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * Quick capture (M4): the fastest possible write into the vault. A capture
 * is deliberately UNTYPED — no type is what puts it in the Inbox, and
 * choosing a type is the act of organizing it later. Nothing here asks the
 * user for structure.
 */

/** `2026-07-28-1432` — enough to keep same-day captures from colliding. */
export function captureStamp(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `${date}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/** Filename stem for a capture: from its title when it has one, else a stamp. */
export function captureSlug(title: string, now: Date = new Date()): string {
  const slug = slugify(title);
  return slug === '' ? `capture-${captureStamp(now)}` : slug;
}

/**
 * Create an untyped note in `inbox/` and return its path. The body carries
 * the H1 only when a title was given: an untitled capture SHOULD read as
 * untitled in the queue, so the organize checklist can flag it.
 */
export async function captureNote(title = ''): Promise<string> {
  const trimmed = title.trim();
  const body = trimmed === '' ? '' : `# ${trimmed}\n`;
  return useVaultStore.getState().createItem({
    folder: INBOX_DIR,
    slug: captureSlug(trimmed),
    frontmatter: {},
    body,
  });
}
