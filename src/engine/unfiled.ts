import { dateEpoch } from './dateGrammar';
import {
  classifyAddress,
  getCorrespondenceIndex,
  normalizeDomain,
  type CorrespondenceIndex,
  type ThreadDigest,
} from './correspondents';
import { domainOf, normalizeAddress } from './mailAddress';
import type { Entry, Schema } from './types';
export interface MailDismissal {
  kind: 'address' | 'domain';
  value: string;
  dismissedAt: string;
}
export type DismissalKind = MailDismissal['kind'];
/** D3 cases: src-tauri/fixtures/mail-dismissal-cases.json, also replayed by Rust and mock IPC. */
export function dismissalValue(
  kind: string,
  raw: string,
): { ok: true; value: string } | { ok: false; error: string } {
  if (kind !== 'address' && kind !== 'domain')
    return { ok: false, error: 'Choose an address or domain to dismiss.' };
  const value = kind === 'address' ? normalizeAddress(raw) : normalizeDomain(raw);
  if (value === null || [...value].length < 3 || [...value].length > 320)
    return {
      ok: false,
      error: `Use a valid mail ${kind === 'address' ? 'address' : 'domain'} with 3 to 320 characters.`,
    };
  return { ok: true, value };
}
export type UnfiledCompany =
  | { state: 'consumer' | 'own' | 'dismissed' | 'ambiguous' | 'unfiled' }
  | { state: 'filed'; entry: Entry };
export interface UnfiledRow {
  address: string;
  name: string | null;
  domain: string;
  threads: ThreadDigest[];
  lastSentAt: string | null;
  company: UnfiledCompany;
}
export function companyFor(
  domain: string,
  index: CorrespondenceIndex,
  dismissals: readonly MailDismissal[],
): UnfiledCompany {
  if (index.ownerDomains.has(domain)) return { state: 'own' };
  if (classifyAddress(`someone@${domain}`, index) === 'consumer') return { state: 'consumer' };
  if (index.ambiguousDomains.has(domain)) return { state: 'ambiguous' };
  const entry = index.resolvedDomains.get(domain);
  if (entry !== undefined) return { state: 'filed', entry };
  if (dismissals.some((row) => row.kind === 'domain' && row.value === domain))
    return { state: 'dismissed' };
  return { state: 'unfiled' };
}
/** Called only while the lane is open. Header facts do not supply names or sent-message counts. */
export function unfiledCorrespondents(
  entries: Entry[],
  schema: Schema,
  dismissals: readonly MailDismissal[],
) {
  const index = getCorrespondenceIndex(entries, schema);
  const rows = new Map<string, UnfiledRow>();
  for (const thread of index.threads)
    for (const address of thread.sentTo) {
      const classification = classifyAddress(address, index);
      if (
        classification === 'owner' ||
        classification === 'role' ||
        index.resolved.has(address) ||
        index.ambiguous.has(address) ||
        dismissals.some((row) => row.kind === 'address' && row.value === address)
      )
        continue;
      const domain = domainOf(address);
      if (domain === null) continue;
      let row = rows.get(address);
      if (row === undefined) {
        row = {
          address,
          name: null,
          domain,
          threads: [],
          lastSentAt: null,
          company: companyFor(domain, index, dismissals),
        };
        rows.set(address, row);
      }
      row.threads.push(thread);
      if (
        thread.lastSentAt !== null &&
        (row.lastSentAt === null || dateEpoch(thread.lastSentAt)! > dateEpoch(row.lastSentAt)!)
      )
        row.lastSentAt = thread.lastSentAt;
    }
  return {
    hasMail: index.hasMail,
    unreadable: index.unreadable,
    rows: [...rows.values()].sort(
      (a, b) =>
        (b.lastSentAt === null ? -Infinity : dateEpoch(b.lastSentAt)!) -
          (a.lastSentAt === null ? -Infinity : dateEpoch(a.lastSentAt)!) ||
        a.address.localeCompare(b.address),
    ),
  };
}
export function correspondentTitle(row: Pick<UnfiledRow, 'name' | 'address'>): string {
  return (
    [...(row.name ?? row.address.split('@')[0])]
      .filter((char) => !'[]|#^'.includes(char))
      .join('')
      .trim() || 'Person'
  );
}

/** SQLite's binary UTF-8 order is Unicode scalar order, not the locale's collation. */
export function dismissalOrder(a: MailDismissal, b: MailDismissal): number {
  const left = [...`${a.kind}\0${a.value}`],
    right = [...`${b.kind}\0${b.value}`];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const delta = left[i].codePointAt(0)! - right[i].codePointAt(0)!;
    if (delta !== 0) return delta;
  }
  return left.length - right.length;
}
