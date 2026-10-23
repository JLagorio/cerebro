import { isTemplate } from '@/lib/templates';
import { isKnowledgePath } from './okf';
import type { Entry } from './types';

/**
 * Inbox (M4) — the capture-then-organize workflow, after Tolaria's Inbox.
 *
 * Fast capture should not require perfect structure, so a note can land in
 * the vault untyped and unlinked; the Inbox is the queue of everything not
 * yet given a shape. Membership is a FLAG, not a folder: folders already
 * mean "project" in cerebro (vault format v2), so a folder-based Inbox
 * would collide with containment the moment you filed a capture.
 *
 * The default is what makes this work on an existing vault without a
 * migration pass:
 *
 *   - an explicit `_organized: true|false` always wins;
 *   - otherwise a note is organized IF IT HAS A TYPE.
 *
 * So every typed record in a vault is already out of the Inbox on day one,
 * and untyped captures collect in it. That also states the workflow's whole
 * point in one line: giving a note a type is what organizing IS.
 */

/** Default folder for quick captures. Membership is the flag, not this dir. */
export const INBOX_DIR = 'inbox';

/** App-managed frontmatter key. `_`-prefixed keys are hidden from property
 * surfaces (see isSystemProperty in engine/properties.ts). */
export const ORGANIZED_KEY = '_organized';

/**
 * Files that are structure rather than content: they are never "captures",
 * so they never queue for organizing no matter what frontmatter they carry.
 * Type docs configure the schema, project.md is a project's identity,
 * templates are scaffolding, and index/log are OKF reserved names (M5).
 */
export function isStructural(entry: Entry): boolean {
  return (
    entry.type === 'Type' ||
    entry.filename === 'project.md' ||
    entry.filename === 'index.md' ||
    entry.filename === 'log.md' ||
    isTemplate(entry) ||
    // Knowledge concepts (M5) are the agent's to write and yours to verify.
    // They are reviewed on the Knowledge surface, not organized in the Inbox.
    isKnowledgePath(entry.path)
  );
}

/** Explicit `_organized` wins; otherwise having a type means organized. */
export function isOrganized(entry: Entry): boolean {
  const flag = entry.properties[ORGANIZED_KEY];
  if (typeof flag === 'boolean') return flag;
  return entry.type !== null;
}

export function inInbox(entry: Entry): boolean {
  return !isStructural(entry) && !isOrganized(entry);
}

/** Inbox contents, newest capture first: every queued capture, however old. */
export function inboxEntries(entries: Entry[]): Entry[] {
  return entries
    .filter(inInbox)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.title.localeCompare(b.title));
}

/** Total Inbox size — the nav badge. */
export function inboxCount(entries: Entry[]): number {
  return entries.filter(inInbox).length;
}
