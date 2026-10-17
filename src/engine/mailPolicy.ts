/** Mail policy is shared data. The accepted pack is a build-time tripwire;
 * the artifact's scoped flag alone controls runtime admission. */
import './whatwgUrl.types';
import { parseURL } from 'whatwg-url';
import raw from '../../shared/policy/mail.v1.json';
export const MAIL_PATH = 'shared/policy/mail.v1.json';
export const MAIL_DIGEST_PATH = 'shared/policy/mail.v1.sha256';
export interface MailGate {
  registry: string;
  connector: string;
  kinds: string[];
  open: boolean;
  scope: string | null;
  pack: string;
}
export interface MailPolicy {
  format: number;
  artifact_version: number;
  rule_version: string;
  folder: string;
  kept_out_of_git: string[];
  gate: MailGate;
  kinds: { thread: string; text: string };
  limits: {
    messages: number;
    addresses_per_message: number;
    participants: number;
    subject_chars: number;
    name_chars: number;
    body_chars: number;
    bodies_chars_per_call: number;
  };
  address_cases: { raw: string; address: string | null }[];
  mailbox_cases: { raw: string; address: string | null; name: string | null }[];
  mail_hosts: string[];
  unattended_denied_tools: string[];
  sweep: {
    window_days: number;
    max_threads: number;
    page_size: number;
    read_tools: string[];
    denied_tools: string[];
  };
  host_cases: { url: string; mail: boolean }[];
  path_cases: { path: string; kept: boolean }[];
  gate_cases: {
    open: boolean;
    scope: string | null;
    kind: string;
    vault_id: string;
    store_uuid: string;
    opens: boolean;
  }[];
  refusals: { at: string[]; set: unknown; error: string }[];
}
const plain = (value: string) =>
  /^[\x21-\x7e]+$/.test(value) &&
  !value.includes('\\') &&
  value
    .split('/')
    .every(
      (part) => part !== '' && part !== '.' && part !== '..' && /^[A-Za-z0-9_.-]+$/.test(part),
    );
const fail = (words: string): never => {
  throw new Error(words);
};
function shape(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail('mail: invalid shape');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key)))
    return fail('mail: invalid shape');
  return row;
}
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
export function parseMailPolicy(value: unknown): MailPolicy {
  const row = shape(value, [
    'format',
    'artifact_version',
    'rule_version',
    'folder',
    'kept_out_of_git',
    'gate',
    'kinds',
    'limits',
    'address_cases',
    'mailbox_cases',
    'mail_hosts',
    'unattended_denied_tools',
    'sweep',
    'host_cases',
    'path_cases',
    'gate_cases',
    'refusals',
  ]);
  const gate = shape(row.gate, ['registry', 'connector', 'kinds', 'open', 'scope', 'pack']);
  const kinds = shape(row.kinds, ['thread', 'text']);
  const sweep = shape(row.sweep, [
    'window_days',
    'max_threads',
    'page_size',
    'read_tools',
    'denied_tools',
  ]);
  const limits = shape(row.limits, [
    'messages',
    'addresses_per_message',
    'participants',
    'subject_chars',
    'name_chars',
    'body_chars',
    'bodies_chars_per_call',
  ]);
  if (
    typeof row.format !== 'number' ||
    typeof row.artifact_version !== 'number' ||
    typeof row.rule_version !== 'string' ||
    typeof row.folder !== 'string' ||
    Object.values(kinds).some((value) => typeof value !== 'string') ||
    Object.values(limits).some((value) => typeof value !== 'number') ||
    !strings(row.kept_out_of_git) ||
    !strings(row.mail_hosts) ||
    !strings(row.unattended_denied_tools) ||
    ['window_days', 'max_threads', 'page_size'].some((key) => typeof sweep[key] !== 'number') ||
    !strings(sweep.read_tools) ||
    !strings(sweep.denied_tools) ||
    !strings(gate.kinds) ||
    typeof gate.registry !== 'string' ||
    typeof gate.connector !== 'string' ||
    typeof gate.open !== 'boolean' ||
    (gate.scope !== null && typeof gate.scope !== 'string') ||
    typeof gate.pack !== 'string'
  )
    fail('mail: invalid shape');
  for (const key of [
    'path_cases',
    'gate_cases',
    'host_cases',
    'refusals',
    'address_cases',
    'mailbox_cases',
  ])
    if (!Array.isArray(row[key])) fail('mail: invalid shape');
  for (const key of ['address_cases', 'mailbox_cases']) {
    for (const value of row[key] as unknown[]) {
      const c = shape(
        value,
        key === 'address_cases' ? ['raw', 'address'] : ['raw', 'address', 'name'],
      );
      if (
        typeof c.raw !== 'string' ||
        (c.address !== null && typeof c.address !== 'string') ||
        (key === 'mailbox_cases' && c.name !== null && typeof c.name !== 'string')
      )
        fail('mail: invalid shape');
    }
  }
  for (const value of row.host_cases as unknown[]) {
    const c = shape(value, ['url', 'mail']);
    if (typeof c.url !== 'string' || typeof c.mail !== 'boolean') fail('mail: invalid shape');
  }
  for (const value of row.path_cases as unknown[]) {
    const c = shape(value, ['path', 'kept']);
    if (typeof c.path !== 'string' || typeof c.kept !== 'boolean') fail('mail: invalid shape');
  }
  for (const value of row.gate_cases as unknown[]) {
    const c = shape(value, ['open', 'scope', 'kind', 'vault_id', 'store_uuid', 'opens']);
    if (
      typeof c.open !== 'boolean' ||
      typeof c.opens !== 'boolean' ||
      (c.scope !== null && typeof c.scope !== 'string') ||
      ['kind', 'vault_id', 'store_uuid'].some((key) => typeof c[key] !== 'string')
    )
      fail('mail: invalid shape');
  }
  for (const value of row.refusals as unknown[]) {
    const c = shape(value, ['at', 'set', 'error']);
    if (!strings(c.at) || typeof c.error !== 'string') fail('mail: invalid shape');
  }
  const table = value as MailPolicy;
  if (table.format !== 1) fail('mail.format must be 1');
  if (!Number.isSafeInteger(table.artifact_version) || table.artifact_version < 1)
    fail('mail.artifact_version must be a positive integer');
  // Unicode White_Space matches Rust str::trim: FEFF is content, U+0085 is space.
  if (!/[^\p{White_Space}]/u.test(table.rule_version)) fail('mail.rule_version must not be empty');
  if (!plain(table.folder) || !table.folder.startsWith('sources/'))
    fail('mail.folder must be a plain ASCII relative path under sources/');
  if (
    !table.kept_out_of_git.includes(`${table.folder}/`) ||
    new Set(table.kept_out_of_git).size !== table.kept_out_of_git.length ||
    table.kept_out_of_git.some((path) => !path.endsWith('/') || !plain(path.slice(0, -1)))
  )
    fail(
      'mail.kept_out_of_git must contain unique plain folders with trailing slashes, including the mail folder',
    );
  if (
    !table.mail_hosts.length ||
    new Set(table.mail_hosts).size !== table.mail_hosts.length ||
    table.mail_hosts.some(
      (host) =>
        !host.includes('.') ||
        host.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)),
    )
  )
    fail('mail.mail_hosts must contain unique lowercase ASCII dotted hosts');
  if (
    !table.unattended_denied_tools.length ||
    new Set(table.unattended_denied_tools).size !== table.unattended_denied_tools.length ||
    table.unattended_denied_tools.some((tool) => !/^[A-Za-z0-9_-]{1,64}$/.test(tool))
  )
    fail('mail.unattended_denied_tools must contain unique tool-part names');
  if (table.gate.registry !== 'R14') fail('mail.gate.registry must be R14');
  const s = table.sweep;
  if (
    [s.window_days, s.max_threads, s.page_size].some(
      (n) => !Number.isInteger(n) || n < 1 || n > 1_000_000,
    ) ||
    s.page_size > 50 ||
    s.page_size > s.max_threads
  )
    fail(
      'mail.sweep limits must be positive integers, with page_size at most 50 and no greater than max_threads',
    );
  if (
    [s.read_tools, s.denied_tools].some(
      (names) =>
        !names.length ||
        new Set(names).size !== names.length ||
        names.some((name) => !/^[A-Za-z0-9_-]{1,64}$/.test(name)),
    ) ||
    s.read_tools.some((name) => s.denied_tools.includes(name))
  )
    fail('mail.sweep tools must be nonempty unique tool-part names and disjoint');
  if (!/^[a-z0-9-]{1,40}$/.test(table.gate.connector))
    fail('mail.gate.connector must be a lowercase connector id');
  if (
    !table.gate.kinds.length ||
    new Set(table.gate.kinds).size !== table.gate.kinds.length ||
    table.gate.kinds.some((kind) => !/^[a-z_]{1,40}$/.test(kind))
  )
    fail('mail.gate.kinds must be unique lowercase kind names');
  if (
    table.gate.open &&
    (table.gate.scope === null ||
      !/^vault_store:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(table.gate.scope))
  )
    fail('an open mail gate must name one vault_store scope');
  if (!table.gate.open && table.gate.scope !== null) fail('a closed mail gate must have no scope');
  if (
    Object.values(table.kinds).some((kind) => !/^[a-z_]{1,40}$/.test(kind)) ||
    table.kinds.thread === table.kinds.text
  )
    fail('mail.kinds must name distinct lowercase thread and text kinds');
  if (table.gate.kinds.some((kind) => !Object.values(table.kinds).includes(kind)))
    fail('mail.gate.kinds must be declared in mail.kinds');
  if (
    Object.values(table.limits).some(
      (limit) => !Number.isInteger(limit) || limit < 1 || limit > 1_000_000,
    )
  )
    fail('mail.limits must be positive integers at most 1000000');
  if (
    !plain(table.gate.pack) ||
    !table.gate.pack.startsWith('docs/superpowers/evidence/triggers/R14/') ||
    !table.gate.pack.endsWith('.md')
  )
    fail('mail.gate.pack must name a markdown pack under docs/superpowers/evidence/triggers/R14/');
  return table;
}
export const MAIL = parseMailPolicy(raw);
export function isKeptOutOfGit(path: string, table: MailPolicy = MAIL): boolean {
  const normalized = path.replace(/^(?:\.\/|\/)+/, '').replace(/[A-Z]/g, (c) => c.toLowerCase());
  return table.kept_out_of_git.some((entry) => {
    const prefix = entry.slice(0, -1).replace(/[A-Z]/g, (c) => c.toLowerCase());
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  });
}
export function gateOpens(
  kind: string,
  vaultId: string,
  storeUuid: string,
  table: MailPolicy = MAIL,
): boolean {
  return (
    table.gate.open &&
    table.gate.kinds.includes(kind) &&
    table.gate.scope === `vault_store:${vaultId}:${storeUuid}`
  );
}

/** A pure WHATWG parser supplies the same decoded/IDNA host as Rust's URL
 * reader. Userinfo, ports, paths and queries can never impersonate the host. */
export function isMailUrl(value: string, table: MailPolicy = MAIL): boolean {
  const url = parseURL(value);
  if (!url || (url.scheme !== 'http' && url.scheme !== 'https') || typeof url.host !== 'string')
    return false;
  const host = url.host.replace(/\.$/, '');
  return table.mail_hosts.some((mail) => host === mail || host.endsWith(`.${mail}`));
}
export function isMailPath(path: string, table: MailPolicy = MAIL): boolean {
  const normalized = path.replace(/^(?:\.\/|\/)+/, '').replace(/[A-Z]/g, (c) => c.toLowerCase());
  const folder = table.folder.toLowerCase();
  return normalized === folder || normalized.startsWith(`${folder}/`);
}
