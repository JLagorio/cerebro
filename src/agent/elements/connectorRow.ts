import {
  approvalKey,
  CONNECTOR_PRESETS,
  httpHeaders,
  httpOAuth,
  httpTimeout,
  presetHolder,
  signInBlocker,
  signInCommand,
  stateLabel,
  stdioEnv,
  type ConnectorSpec,
  type ConnectorState,
  type ConnectorStatusRow,
} from '@/engine/connectors';

/**
 * One entry of the vault's connector list as Settings says it (M54.11), and
 * as the conversation rail's Connectors card says it (M92.9): the one
 * derivation of a connector's status words, so the two surfaces never tell
 * two stories. Pure.
 *
 * The first rule that holds names the row's state: the entry's switch; a
 * name Rust can never grant, in Rust's own words; this machine's approval;
 * then what the newest run that used it saw (`connector_status`), or that no
 * run has. While the status read is out, or after it failed, the row says
 * no state at all (CV-05): a failed read is never "not observed yet".
 */

/** The status read (M54.11). A failed read is its own state, never no rows. */
export type ConnectorStatusRead =
  | { kind: 'loading' }
  | { kind: 'ready'; rows: readonly ConnectorStatusRow[] }
  | { kind: 'unavailable'; reason: string };

/** What a row's state is, in the order its rules are read. */
export type ConnectorRowKey =
  'off' | 'refused' | 'unapproved' | 'loading' | 'unavailable' | 'not_observed' | ConnectorState;

/** What a row says after its name. `words` is null while the status is
 *  loading or unreadable, so no row claims an observation nobody could
 *  read. */
export interface ConnectorRowStatus {
  key: ConnectorRowKey;
  words: string | null;
}

/** The states a run observed: only these carry when it was seen. */
const OBSERVED: readonly ConnectorRowKey[] = ['working', 'needs_sign_in', 'failed', 'not_approved'];

/** The states whose words read as plain facts; every other one is a
 *  warning. */
const QUIET: readonly ConnectorRowKey[] = ['working', 'off', 'not_observed'];

/** One line on what to do about a state, where there is something to do. */
export const CONNECTOR_HINTS: Partial<Record<ConnectorRowKey, string>> = {
  failed:
    'The last run that used it got no answer from it — check that the server is up and its URL is right.',
  not_approved:
    'Your own Claude Code permission rules stopped its tools in the last run — allow them with /permissions in claude.',
};

/** Why an entry is not approved here: what its transport does, or what
 *  keeps it from ever being approved (`approval` is its approval key, null
 *  for an entry that can never be approved). */
function unapprovedWhy(spec: ConnectorSpec, approval: string | null): string {
  if (spec.transport === 'stdio')
    return approval === null ? 'malformed env' : 'runs a local command';
  if (httpHeaders(spec) === null) return 'malformed headers';
  if (httpOAuth(spec) === null) return 'oauth Claude Code would refuse';
  if (httpTimeout(spec) === null) return 'timeout Claude Code would refuse';
  return 'not approved on this machine';
}

/** Pairs sorted by key, the order a fingerprint sorts them in. */
function sortedPairs<V>(record: Record<string, V>): [string, V][] {
  return Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * What Approve approves, on the table (PR #5 security review): for http the
 * URL, every header and the oauth (M69.1), for stdio the env pairs and the
 * command line, each sorted as the fingerprint sorts them. Header and env
 * values are often credentials, so only Settings, where a person approves
 * them, draws this; it is never part of a row.
 */
export function approvalLine(spec: ConnectorSpec): string {
  if (spec.transport === 'http') {
    return [
      spec.url,
      ...sortedPairs(httpHeaders(spec) ?? {}).map(([k, v]) => `${k}: ${v}`),
      ...sortedPairs(httpOAuth(spec) ?? {}).map(([k, v]) => `oauth ${k}: ${v}`),
    ].join(' · ');
  }
  return [
    ...sortedPairs(stdioEnv(spec) ?? {}).map(([k, v]) => `${k}=${v}`),
    spec.command,
    ...spec.args,
  ].join(' ');
}

/** What a row that needs sign-in says in place of a command it cannot show. */
export function signInWithout(spec: ConnectorSpec): string {
  switch (signInBlocker(spec)) {
    case 'name':
      return `Claude Code adds a connector only under a name of letters, digits, - and _, so rename ${spec.name} here, then sign in.`;
    case 'entry':
      return 'Its URL or one of its headers holds a character other than printable ASCII, which a pasted command must not carry, so fix this entry in .cerebro/connectors.json, then sign in.';
    case 'stdio':
    case null:
      return `Run claude, type /mcp, and sign in to ${spec.name}.`;
  }
}

/** One entry of the list, as both surfaces derive it. */
export interface ConnectorRow {
  spec: ConnectorSpec;
  /** Its approval key (a digest, never the fingerprint), or null for an
   *  entry that can never be approved. */
  approval: string | null;
  /** Not approved on this machine. */
  unapproved: boolean;
  status: ConnectorRowStatus;
  /** Its words read as a plain fact, not a warning. */
  quiet: boolean;
  /** When the run that saw an observed state saw it. */
  observedAt: string | null;
  hint: string | undefined;
  /** It shows its sign-in: it needs one, or it is a preset no run has used
   *  yet, which was added to be signed in to (M69.1). */
  signIn: boolean;
  /** The command that adds it to the person's own Claude Code, where /mcp
   *  signs in; null where it needs none or one cannot carry it safely. */
  command: string | null;
}

/**
 * Entry `spec` of the vault's list, with this machine's approvals (their
 * keys) and the newest status read.
 */
export function connectorRow(
  spec: ConnectorSpec,
  approvals: readonly string[],
  status: ConnectorStatusRead,
): ConnectorRow {
  // The file naming an entry travels with the vault, so the entry stays out
  // of runs until a person approves its exact spec on this machine: a stdio
  // entry names a command this app would EXECUTE, and an http one a server
  // whose tools a run is granted (M54.9).
  const approval = approvalKey(spec);
  const unapproved = approval === null || !approvals.includes(approval);
  const seen =
    status.kind === 'ready' ? status.rows.find((row) => row.connector === spec.name) : undefined;
  const said: ConnectorRowStatus = !spec.enabled
    ? { key: 'off', words: 'off' }
    : seen?.refused != null
      ? { key: 'refused', words: `can’t be granted: ${seen.refused}` }
      : unapproved
        ? { key: 'unapproved', words: unapprovedWhy(spec, approval) }
        : status.kind !== 'ready'
          ? { key: status.kind, words: null }
          : { key: seen?.state ?? 'not_observed', words: stateLabel(seen?.state ?? null) };
  const preset = CONNECTOR_PRESETS.some((p) => presetHolder(p, [spec]) !== undefined);
  const signIn = said.key === 'needs_sign_in' || (said.key === 'not_observed' && preset);
  return {
    spec,
    approval,
    unapproved,
    status: said,
    quiet: QUIET.includes(said.key),
    observedAt: OBSERVED.includes(said.key) ? (seen?.seen_at ?? null) : null,
    hint: CONNECTOR_HINTS[said.key],
    signIn,
    command: signIn ? signInCommand(spec) : null,
  };
}

/** The Settings focus (`settingsFocus`) that opens Settings at a connector's
 *  row: the rail's Sign in… sets it (M92.9). */
const FOCUS = 'connector:';

export function connectorFocus(name: string): string {
  return `${FOCUS}${name}`;
}

/** The connector a Settings focus names, or null for any other focus. */
export function focusedConnector(focus: string | null): string | null {
  return focus !== null && focus.startsWith(FOCUS) ? focus.slice(FOCUS.length) : null;
}
