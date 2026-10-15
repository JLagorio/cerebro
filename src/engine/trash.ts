import { hfsHeard } from './okf';

/**
 * The vault's own Trash (M60.8): nothing a person deletes is hard-deleted.
 * The TS twin of src-tauri/src/vault/trash.rs; both replay
 * src-tauri/fixtures/trash-cases.json, so the mock backend moves, lists and
 * refuses exactly as the real one does.
 *
 * A delete moves the item to `.trash/<stamp>/<path>`, its comment sidecar to
 * `.trash/<stamp>/.comments/`, and writes `.trashed.json` beside them:
 * `{format, path, kind, title, deleted_at}`, two-space JSON and a final
 * newline. A stamp is the UTC second plus four lowercase hex characters.
 * The launch purge moves stamp dirs past `KEEP_DAYS`, judged by the stamp.
 */

export const TRASH_DIR = '.trash';
export const MANIFEST = '.trashed.json';
export const KEEP_DAYS = 30;
export const MANIFEST_FORMAT = 1;

/** One item in the Trash, as Settings lists it (Rust's `TrashedItem`). */
export interface TrashedItem {
  stamp: string;
  /** The vault path it came from; for an unreadable item, its stamp dir. */
  path: string;
  kind: 'file' | 'folder' | 'unreadable';
  /** The title it had when it went; empty for an unreadable item. */
  title: string;
  /** When it went, RFC 3339 UTC to the second. */
  deletedAt: string;
  /** Pages inside, or null when nobody could count them (CV-05). */
  pages: number | null;
}

/** A stamp dir's manifest, keys in the file's order. */
export interface TrashManifest {
  format: number;
  path: string;
  kind: 'file' | 'folder';
  title: string;
  deleted_at: string;
}

// --- Words (trash-cases.json `words`, Appendix B) ----------------------------

export const notAPage = (path: string): string =>
  `${path} is not a page Cerebro shows, so it can't go to the Trash.`;
export const alreadyExists = (path: string): string =>
  `${path} already exists, so nothing was restored. Move or rename that page first.`;
export const UNREADABLE_ITEM = "This Trash item can't be read, so it can't be restored.";
export const nothingAt = (stamp: string): string => `Nothing in the Trash at ${stamp}.`;

/** What the person reads around a delete and a restore. */
export const TRASH_WORDS = {
  body: 'It moves to the Trash.',
  folder: 'The folder and everything inside it move to the Trash.',
  doc: 'The whole doc — every page in it — moves to the Trash.',
  bulk: 'They move to the Trash. Links to them point at nothing until they are restored.',
  footer: `Restore from Settings → Recently deleted for ${KEEP_DAYS} days.`,
  section: 'Recently deleted',
  hint: `Deleted pages wait here for ${KEEP_DAYS} days, then move to the macOS Trash when Cerebro starts. Search and agents never see them.`,
  empty: 'Nothing in the Trash.',
} as const;

export const movedToast = (label: string): string => `Moved “${label}” to Trash`;
export const couldntMoveToast = (label: string): string => `Couldn't move “${label}” to Trash`;
export const movedRecordsToast = (n: number): string => `Moved ${n} records to Trash`;
export const restoredToast = (title: string): string => `Restored “${title}”`;
export const unavailableWords = (reason: string): string => `Couldn't read the Trash: ${reason}`;

// --- Stamps --------------------------------------------------------------------

const STAMP = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-[0-9a-f]{4}$/;

/** The second a stamp names, or null when `name` is no stamp. */
export function parseStamp(name: string): Date | null {
  const m = STAMP.exec(name);
  if (m === null) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  if (h > 23 || mi > 59 || s > 59) return null;
  const at = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  // Date.UTC rolls an impossible day over (Feb 30 -> Mar 2); a stamp may not.
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== mo - 1 || at.getUTCDate() !== d) {
    return null;
  }
  return at;
}

/** A second as the manifest spells it. */
export function rfc3339(at: Date): string {
  return `${at.toISOString().slice(0, 19)}Z`;
}

/** The stamp for a delete at `at`, with `rng` (0..65535) as its hex. */
export function newStamp(at: Date, rng: number): string {
  const compact = rfc3339(at).replace(/[-:]/g, '');
  return `${compact}-${rng.toString(16).padStart(4, '0')}`;
}

/** Is a stamp dir minted at `at` past `keepDays` at `now`? */
export function expired(at: Date, now: Date, keepDays: number = KEEP_DAYS): boolean {
  return at.getTime() + keepDays * 86_400_000 < now.getTime();
}

/** When an item went, or null when neither its record nor its stamp says. */
export function deletedWhen(item: TrashedItem): Date | null {
  const at = new Date(item.deletedAt);
  return Number.isNaN(at.getTime()) ? parseStamp(item.stamp) : at;
}

/** When the launch purge may move an item to the OS Trash, or null. */
export function purgeWhen(item: TrashedItem, keepDays: number = KEEP_DAYS): Date | null {
  const at = parseStamp(item.stamp);
  return at === null ? null : new Date(at.getTime() + keepDays * 86_400_000);
}

// --- Manifests -----------------------------------------------------------------

/** A name the scan hides (scan.rs `is_hidden`). */
export const isHiddenName = (name: string): boolean => hfsHeard(name).startsWith('.');

/** A vault path a Trash item may name: names none empty, `..` or hidden. */
export function isItemPath(rel: string): boolean {
  return rel !== '' && rel.split('/').every((n) => n !== '' && n !== '..' && !isHiddenName(n));
}

export function manifestBytes(manifest: TrashManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** A manifest read back, or null when it can't be (trash.rs `parse_manifest`). */
export function parseManifest(text: string): TrashManifest | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (o.format !== MANIFEST_FORMAT) return null;
  if (typeof o.path !== 'string' || !isItemPath(o.path)) return null;
  if (o.kind !== 'file' && o.kind !== 'folder') return null;
  if (typeof o.title !== 'string' || typeof o.deleted_at !== 'string') return null;
  return {
    format: MANIFEST_FORMAT,
    path: o.path,
    kind: o.kind,
    title: o.title,
    deleted_at: o.deleted_at,
  };
}
