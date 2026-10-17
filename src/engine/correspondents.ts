import { isConsumerDomain } from '@/lib/consumerDomains';
import { dateEpoch, parseDateText } from './dateGrammar';
import { normalizeAddress, domainOf } from './mailAddress';
import { MAIL, isMailPath } from './mailPolicy';
import { isRoleAddress } from './mailRoles';
import { isKnowledgePath } from './okf';
import './whatwgUrl.types';
import { parseURL } from 'whatwg-url';
import type { Entry, FieldDef, Schema } from './types';

export interface ThreadDigest {
  entry: Entry;
  participants: string[];
  sentTo: string[];
  owners: string[];
  firstMessageAt: string;
  lastMessageAt: string;
  lastSentAt: string | null;
  lastInboundAt: string | null;
  lastFrom: string;
  needsReply: boolean;
  messageCount: number;
}
export interface CorrespondenceIndex {
  hasMail: boolean;
  unreadable: number;
  threads: ThreadDigest[];
  owners: ReadonlySet<string>;
  addresses: ReadonlyMap<string, string[]>;
  domains: ReadonlyMap<string, string>;
  ownerDomains: ReadonlySet<string>;
  resolvedDomains: ReadonlyMap<string, Entry>;
  ambiguousDomains: ReadonlyMap<string, Entry[]>;
  resolved: ReadonlyMap<string, Entry>;
  ambiguous: ReadonlyMap<string, Entry[]>;
  byRecord: ReadonlyMap<string, ThreadDigest[]>;
}

const instant = (value: unknown): value is string =>
  typeof value === 'string' && parseDateText(value)?.instant === true;
function addressList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const read = value.map((item) => (typeof item === 'string' ? normalizeAddress(item) : null));
  return read.some((item) => item === null) ? null : [...new Set(read as string[])];
}

/** Digests are a cache capability, never a reserved Type-name match. */
export function threadDigests(entries: readonly Entry[]): {
  threads: ThreadDigest[];
  unreadable: number;
  hasMail: boolean;
} {
  const threads: ThreadDigest[] = [];
  let unreadable = 0;
  let hasMail = false;
  for (const entry of entries) {
    if (!isMailPath(entry.path)) continue;
    const p = entry.properties;
    if (entry.parseError !== null) {
      // A failed scan cannot reveal the kind. Keep that failure visible,
      // except a text page whose kind is still explicitly recorded.
      if (p.source_kind !== MAIL.kinds.text) {
        unreadable++;
        hasMail = true;
      }
      continue;
    }
    if (p.source_kind !== MAIL.kinds.thread) continue;
    hasMail = true;
    const participants = addressList(p.participants);
    const sentTo = addressList(p.sent_to);
    const owners = addressList(p.owner_addresses);
    const lastFrom = typeof p.last_from === 'string' ? normalizeAddress(p.last_from) : null;
    if (
      participants === null ||
      sentTo === null ||
      owners === null ||
      lastFrom === null ||
      !instant(p.first_message_at) ||
      !instant(p.last_message_at) ||
      (p.last_sent_at !== undefined && !instant(p.last_sent_at)) ||
      (p.last_inbound_at !== undefined && !instant(p.last_inbound_at)) ||
      typeof p.needs_reply !== 'boolean' ||
      typeof p.message_count !== 'number' ||
      !Number.isSafeInteger(p.message_count) ||
      p.message_count < 1
    ) {
      unreadable++;
      continue;
    }
    threads.push({
      entry,
      participants,
      sentTo,
      owners,
      firstMessageAt: p.first_message_at,
      lastMessageAt: p.last_message_at,
      lastSentAt: (p.last_sent_at as string | undefined) ?? null,
      lastInboundAt: (p.last_inbound_at as string | undefined) ?? null,
      lastFrom,
      needsReply: p.needs_reply,
      messageCount: p.message_count,
    });
  }
  threads.sort(
    (a, b) =>
      compareInstant(b.lastMessageAt, a.lastMessageAt) || a.entry.path.localeCompare(b.entry.path),
  );
  return { threads, unreadable, hasMail };
}

/** Only a declared stored email field claims an address. */
export function recordAddresses(entry: Entry, schema: Pick<Schema, 'types'>): string[] {
  if (isKnowledgePath(entry.path) || isMailPath(entry.path) || entry.parseError !== null) return [];
  const type = entry.type === null ? null : schema.types.get(entry.type);
  const addresses =
    type?.fields
      .filter((field) => field.kind === 'email')
      .flatMap((field) => {
        const value = entry.properties[field.name];
        return (Array.isArray(value) ? value : [value]).flatMap((raw) => {
          const address = typeof raw === 'string' ? normalizeAddress(raw) : null;
          return address === null ? [] : [address];
        });
      }) ?? [];
  return [...new Set(addresses)];
}

/** A domain may be authored alone or in a web URL; paths never become identity. */
export function normalizeDomain(raw: string): string | null {
  const value = raw.trim();
  if (value === '' || /[\s\p{Cc}]/u.test(value)) return null;
  const parsed = parseURL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`);
  if (
    parsed === null ||
    !['http', 'https'].includes(parsed.scheme) ||
    typeof parsed.host !== 'string' ||
    parsed.username !== '' ||
    parsed.password !== ''
  )
    return null;
  const host = parsed.host.toLowerCase().replace(/\.$/, '');
  if (
    !host.includes('.') ||
    !/^[a-z0-9.-]+$/.test(host) ||
    host.split('.').some((part) => !part || part.startsWith('-') || part.endsWith('-')) ||
    /^[0-9.]+$/.test(host)
  )
    return null;
  return host;
}
export function recordDomain(entry: Entry, schema: Pick<Schema, 'types'>): string | null {
  if (isKnowledgePath(entry.path) || isMailPath(entry.path) || entry.parseError !== null)
    return null;
  const key = entry.type === null ? null : schema.types.get(entry.type)?.emailDomain;
  const value = key == null ? null : entry.properties[key];
  return typeof value === 'string' ? normalizeDomain(value) : null;
}

const indexes = new WeakMap<readonly Entry[], CorrespondenceIndex>();
/** Entries are immutable snapshots. A new scan retires the entire derived index. */
export function getCorrespondenceIndex(
  entries: readonly Entry[],
  schema: Pick<Schema, 'types'>,
): CorrespondenceIndex {
  const cached = indexes.get(entries);
  if (cached !== undefined) return cached;
  const mail = threadDigests(entries);
  const owners = new Set(mail.threads.flatMap((thread) => thread.owners));
  const ownerDomains = new Set(
    [...owners].flatMap((address) => {
      const domain = domainOf(address);
      return domain === null ? [] : [domain];
    }),
  );
  const domains = new Map<string, string>();
  const domainClaimants = new Map<string, Entry[]>();
  const addresses = new Map<string, string[]>();
  const claimants = new Map<string, Entry[]>();
  for (const entry of entries) {
    const domain = recordDomain(entry, schema);
    if (domain !== null) {
      domains.set(entry.path, domain);
      const rows = domainClaimants.get(domain) ?? [];
      rows.push(entry);
      domainClaimants.set(domain, rows);
    }
    const values = recordAddresses(entry, schema);
    if (values.length === 0) continue;
    addresses.set(entry.path, values);
    for (const address of values) {
      const rows = claimants.get(address) ?? [];
      rows.push(entry);
      claimants.set(address, rows);
    }
  }
  const resolved = new Map<string, Entry>();
  const ambiguous = new Map<string, Entry[]>();
  for (const [address, records] of claimants) {
    if (owners.has(address)) continue;
    if (records.length === 1) resolved.set(address, records[0]);
    else ambiguous.set(address, records);
  }
  const resolvedDomains = new Map<string, Entry>();
  const ambiguousDomains = new Map<string, Entry[]>();
  for (const [domain, records] of domainClaimants) {
    if (ownerDomains.has(domain) || isConsumerDomain(domain)) continue;
    if (records.length === 1) resolvedDomains.set(domain, records[0]);
    else ambiguousDomains.set(domain, records);
  }
  const byRecord = new Map<string, ThreadDigest[]>();
  for (const thread of mail.threads) {
    const paths = new Set(
      thread.participants.flatMap((address) => {
        const entry = resolved.get(address);
        const domain = domainOf(address);
        const company =
          owners.has(address) || isRoleAddress(address) || domain === null
            ? undefined
            : resolvedDomains.get(domain);
        return [entry, company].flatMap((row) => (row === undefined ? [] : [row.path]));
      }),
    );
    for (const path of paths) {
      const rows = byRecord.get(path) ?? [];
      rows.push(thread);
      byRecord.set(path, rows);
    }
  }
  const result: CorrespondenceIndex = {
    ...mail,
    owners,
    ownerDomains,
    domains,
    resolvedDomains,
    ambiguousDomains,
    addresses,
    resolved,
    ambiguous,
    byRecord,
  };
  indexes.set(entries, result);
  return result;
}

export function classifyAddress(
  address: string,
  index: Pick<CorrespondenceIndex, 'owners'>,
): 'owner' | 'role' | 'consumer' | 'business' {
  const normalized = normalizeAddress(address);
  if (normalized !== null && index.owners.has(normalized)) return 'owner';
  if (isRoleAddress(address)) return 'role';
  return isConsumerDomain(domainOf(address) ?? '') ? 'consumer' : 'business';
}

function compareInstant(a: string, b: string): number {
  return dateEpoch(a)! - dateEpoch(b)!;
}
const latest = (values: (string | null)[]): string | null =>
  values
    .filter((value): value is string => value !== null)
    .sort(compareInstant)
    .at(-1) ?? null;
export type CorrespondenceView =
  | { state: 'silent' }
  | { state: 'domain-blocked'; domain: string; reason: 'consumer' | 'owner'; unreadable: number }
  | {
      state: 'you';
      unreadable: number;
    }
  | {
      state: 'record';
      addresses: string[];
      domain: string | null;
      threads: ThreadDigest[];
      ambiguous: { address: string; others: Entry[] }[];
      unmatched: string[];
      lastMessageAt: string | null;
      lastSentAt: string | null;
      waiting: number;
      unreadable: number;
    };
export function correspondenceView(entry: Entry, index: CorrespondenceIndex): CorrespondenceView {
  const addresses = index.addresses.get(entry.path) ?? [];
  const domain = index.domains.get(entry.path) ?? null;
  if (!index.hasMail || (addresses.length === 0 && domain === null)) return { state: 'silent' };
  if (domain !== null && (isConsumerDomain(domain) || index.ownerDomains.has(domain)))
    return {
      state: 'domain-blocked',
      domain,
      reason: isConsumerDomain(domain) ? 'consumer' : 'owner',
      unreadable: index.unreadable,
    };
  if (addresses.some((address) => index.owners.has(address)))
    return { state: 'you', unreadable: index.unreadable };
  const threads = index.byRecord.get(entry.path) ?? [];
  return {
    state: 'record',
    addresses,
    domain,
    threads,
    ambiguous: [...addresses, ...(domain === null ? [] : [domain])].flatMap((address) => {
      const rows = index.ambiguous.get(address) ?? index.ambiguousDomains.get(address);
      return rows === undefined
        ? []
        : [{ address, others: rows.filter((row) => row.path !== entry.path) }];
    }),
    unmatched: [...addresses, ...(domain === null ? [] : [domain])].filter(
      (address) =>
        !index.ambiguous.has(address) &&
        !index.ambiguousDomains.has(address) &&
        !threads.some((thread) =>
          thread.participants.some(
            (participant) =>
              participant === address ||
              (address === domain &&
                domainOf(participant) === domain &&
                !isRoleAddress(participant)),
          ),
        ),
    ),
    lastMessageAt: latest(threads.map((thread) => thread.lastMessageAt)),
    lastSentAt: latest(threads.map((thread) => thread.lastSentAt)),
    waiting: threads.filter(
      (thread) =>
        thread.needsReply &&
        (index.resolved.get(thread.lastFrom)?.path === entry.path ||
          (!index.owners.has(thread.lastFrom) &&
            !isRoleAddress(thread.lastFrom) &&
            index.resolvedDomains.get(domainOf(thread.lastFrom) ?? '')?.path === entry.path)),
    ).length,
    unreadable: index.unreadable,
  };
}

export const CORRESPONDENCE_PROPERTIES = [
  'last_message_at',
  'first_message_at',
  'last_sent_at',
  'last_inbound_at',
] as const;
/** Cached facts are absent until a digest exists; invalid configuration never becomes zero. */
export function correspondenceRollup(
  entry: Entry,
  def: FieldDef,
  index: CorrespondenceIndex,
): string | number | undefined {
  const view = correspondenceView(entry, index);
  if (view.state !== 'record') return undefined;
  if (view.ambiguous.length > 0 && view.threads.length === 0) return undefined;
  if (def.calculate === 'count') return index.unreadable > 0 ? undefined : view.threads.length;
  if (def.calculate !== 'latest' && def.calculate !== 'earliest') return undefined;
  const property = def.property;
  if (!CORRESPONDENCE_PROPERTIES.includes(property as (typeof CORRESPONDENCE_PROPERTIES)[number]))
    return undefined;
  const values = view.threads
    .flatMap((thread) => {
      const value =
        property === 'last_message_at'
          ? thread.lastMessageAt
          : property === 'first_message_at'
            ? thread.firstMessageAt
            : property === 'last_sent_at'
              ? thread.lastSentAt
              : thread.lastInboundAt;
      return value === null ? [] : [value];
    })
    .sort(compareInstant);
  return def.calculate === 'latest' ? values.at(-1) : values[0];
}
