import {
  connectorRow,
  type ConnectorRowKey,
  type ConnectorStatusRead,
} from '@/agent/elements/connectorRow';
import type { RunReach } from '@/agent/types';
import type { RailSectionState } from '@/components/ai/Rail';
import { readConnectorList, UNREADABLE_CONNECTOR_LIST } from '@/engine/connectors';

/**
 * The rail's Connectors card (M92.9, §0 Q14, §2): the vault's connector
 * list (`readConnectors`), each entry in the status words Settings says it
 * in (`connectorRow`, one derivation for both), joined with what the
 * conversation's latest run said it reaches (`RunReach`, M92.8): which
 * connectors it loaded, which its instructions named and it did not get,
 * with Rust's own reason, word for word, and whether it also loaded the
 * person's own Claude Code connectors. Pure.
 *
 * What it says (CV-05, CV-44): connectors switched off in Settings is one
 * quiet line that says so. A list that could not be read is unavailable,
 * and a status read that failed leaves the rows saying no state, partial. A
 * conversation whose runs never said what they reach is not recorded. With
 * no list, a turn you watch also loads the person's own connectors, which
 * Cerebro neither lists nor controls (only the Context card's breakdown
 * may name their servers after a turn, M92.13), and the card says what that
 * costs (SECURITY.md). Wherever a run merged a connector, the card says that mail
 * is drafted, never sent.
 *
 * Nothing here signs anyone in: a connector that needs it offers Sign in…,
 * which opens Settings at its row, where the `claude /mcp` step is.
 */

/** The card's words. */
export const RAIL_CONNECTORS_WORDS = {
  title: 'Connectors',
  none: 'None',
  /** An empty card's line when Settings' Connectors switch is off. */
  off: 'Off in Settings',
  unavailable: "Couldn't read this vault's connector list",
  /** Rust pins every run to no connector while the list cannot be read
   *  (`connectors::connector_context`); `reason` is why, in its words. */
  unavailableDetail: (reason: string) =>
    reason === ''
      ? 'Runs reach no connectors until it can be read.'
      : `Runs reach no connectors until it can be read: ${reason}`,
  partial: "Couldn't read connector status, so these rows don't say whether each connector works.",
  notRecorded: 'What this conversation reaches is not recorded',
  notRecordedDetail: 'A turn records it as it starts.',
  /** The inherited-connector limit (SECURITY.md, D15). */
  inherited:
    "This vault has no connector list, so a turn you watch also loads your own Claude Code connectors. Cerebro doesn't list or control them: it grants none of their tools, and it cannot block their send tools by name. After a turn, Context may name their servers.",
  /** Said wherever a run merged a connector (D15, CV-62). */
  mail: 'Mail is drafted, never sent: Cerebro blocks the known send tools by name.',
  count: (loaded: number) => `${loaded} loaded`,
  /** Reach is the latest turn's (`threadReach`): an earlier turn may have
   *  loaded what this one did not, so neither line speaks for the whole
   *  conversation. */
  loaded: 'Loaded in the latest turn',
  notLoaded: 'Not loaded in the latest turn',
  /** `reason` is Rust's, verbatim (`connectors::Missing`). */
  missing: (reason: string) => `Not loaded: ${reason}`,
  more: (count: number) =>
    `${count} more ${count === 1 ? 'connector' : 'connectors'} its instructions name not loaded`,
  signIn: 'Sign in…',
  signInLabel: (name: string) => `Sign in to ${name} in Settings (leaves full screen)`,
} as const;

/** The vault's list as the card last read it: '' is no list at all. */
export type ConnectorListRead =
  { kind: 'loading' } | { kind: 'ready'; raw: string } | { kind: 'unavailable'; reason: string };

/** What the conversation's latest run did with a connector. */
export type RailConnectorRun = 'loaded' | 'not-loaded' | 'missing';

/** One connector as the card lists it. */
export interface RailConnectorLine {
  name: string;
  /** Its state as Settings says it (`connectorRow`); `unlisted` for one the
   *  vault's list does not hold, which a run's instructions named or a run
   *  loaded before the list changed. */
  status: ConnectorRowKey | 'unlisted';
  /** Its words after its name, Settings' own; null where there are none to
   *  say: the status unread, or a connector the list does not hold. */
  words: string | null;
  /** Its words read as a plain fact, not a warning. */
  quiet: boolean;
  /** What the latest run did with it; null when no run said (not
   *  recorded). */
  run: RailConnectorRun | null;
  /** That, in words; a missing one's reason is Rust's, verbatim. */
  facts: string | null;
  /** It needs a sign-in Settings shows: the card offers Sign in…. */
  signIn: boolean;
}

export interface RailConnectors {
  /** The card's state (CV-44), or null while its reads are out: a claim made
   *  then could be wrong a moment later, so the card makes none. */
  state: RailSectionState | null;
  /** What an empty card says after its name. */
  none: string;
  /** What the heading line says after the name. */
  count: string | undefined;
  lines: readonly RailConnectorLine[];
  /** How many more connectors the run's instructions named than its reach
   *  names one by one, in words. */
  more: string | null;
  /** Why the list could not be read: the unavailable card's detail. */
  reason: string | null;
  /** Say the inherited-connector limit. */
  inherited: boolean;
  /** Say that mail is drafted, never sent. */
  mail: boolean;
}

export interface RailConnectorsInput {
  /** The open vault; null reads nothing. */
  vault: string | null;
  /** Settings' Connectors switch (`agentConnectors`). */
  enabled: boolean;
  list: ConnectorListRead;
  status: ConnectorStatusRead;
  /** This machine's approval keys for the vault. */
  approvals: readonly string[];
  /** What the conversation's latest run said it reaches
   *  (`conversations.threadReach`); null when none has. */
  reach: RunReach | null;
}

const NO_LINES: readonly RailConnectorLine[] = Object.freeze([]);

function quiet(none: string): RailConnectors {
  return {
    state: 'empty',
    none,
    count: undefined,
    lines: NO_LINES,
    more: null,
    reason: null,
    inherited: false,
    mail: false,
  };
}

/** What the latest run did with connector `name`, and its facts line. */
function runOf(name: string, reach: RunReach | null): Pick<RailConnectorLine, 'run' | 'facts'> {
  if (reach === null) return { run: null, facts: null };
  if (reach.connectors.some((loaded) => loaded.name === name)) {
    return { run: 'loaded', facts: RAIL_CONNECTORS_WORDS.loaded };
  }
  const missing = reach.missing.find((named) => named.name === name);
  if (missing !== undefined) {
    return { run: 'missing', facts: RAIL_CONNECTORS_WORDS.missing(missing.reason) };
  }
  return { run: 'not-loaded', facts: RAIL_CONNECTORS_WORDS.notLoaded };
}

/** A connector the vault's list does not hold, as a run named it. */
function unlisted(name: string, reach: RunReach): RailConnectorLine {
  return {
    name,
    status: 'unlisted',
    words: null,
    quiet: true,
    signIn: false,
    ...runOf(name, reach),
  };
}

/**
 * The card, from its reads, Settings' switch and approvals, and the run's
 * reach. Its state, first rule wins: no vault or the switch off is empty;
 * a read out makes no claim; a list that could not be read, or whose bytes
 * do not parse, is unavailable;
 * a status read that failed is partial; no run's reach is not recorded;
 * nothing to list and nothing to say is empty; else ready.
 */
export function railConnectors({
  vault,
  enabled,
  list,
  status,
  approvals,
  reach,
}: RailConnectorsInput): RailConnectors {
  if (vault === null) return quiet(RAIL_CONNECTORS_WORDS.none);
  if (!enabled) return quiet(RAIL_CONNECTORS_WORDS.off);
  if (list.kind === 'loading' || status.kind === 'loading') {
    return { ...quiet(RAIL_CONNECTORS_WORDS.none), state: null };
  }
  if (list.kind === 'unavailable') {
    return { ...quiet(RAIL_CONNECTORS_WORDS.none), state: 'unavailable', reason: list.reason };
  }
  // Bytes that do not parse are a list Rust cannot read either, never no
  // connectors: it pins every run to none, in these words (CV-05).
  const read = readConnectorList(list.raw);
  if (read.kind === 'unreadable') {
    return {
      ...quiet(RAIL_CONNECTORS_WORDS.none),
      state: 'unavailable',
      reason: UNREADABLE_CONNECTOR_LIST,
    };
  }
  const specs = read.specs;
  const listed = new Set(specs.map((spec) => spec.name));
  const lines: RailConnectorLine[] = specs.map((spec) => {
    const row = connectorRow(spec, approvals, status);
    return {
      name: spec.name,
      status: row.status.key,
      words: row.status.words,
      quiet: row.quiet,
      signIn: row.signIn,
      ...runOf(spec.name, reach),
    };
  });
  if (reach !== null) {
    // What the run's instructions named and the list does not hold, then
    // what it loaded that the list no longer holds, each once.
    for (const named of [...reach.missing, ...reach.connectors]) {
      if (listed.has(named.name)) continue;
      listed.add(named.name);
      lines.push(unlisted(named.name, reach));
    }
  }
  const more =
    reach !== null && reach.missing_more > 0
      ? RAIL_CONNECTORS_WORDS.more(reach.missing_more)
      : null;
  // No list at all: a turn you watch that names no connector also loads the
  // person's own, which no run here pinned away (`inherits`).
  const inherited = list.raw.trim() === '' && (reach === null || reach.inherits);
  const mail = reach !== null && reach.connectors.length > 0;
  const state: RailSectionState =
    status.kind === 'unavailable' && specs.length > 0
      ? 'partial'
      : reach === null
        ? 'not-recorded'
        : lines.length === 0 && more === null && !inherited
          ? 'empty'
          : 'ready';
  return {
    state,
    none: RAIL_CONNECTORS_WORDS.none,
    // The list's connectors the run loaded; none says nothing, since the
    // person's own may have loaded beside them unnamed.
    count:
      reach === null || reach.connectors.length === 0
        ? undefined
        : RAIL_CONNECTORS_WORDS.count(reach.connectors.length),
    lines: lines.length === 0 ? NO_LINES : lines,
    more,
    reason: null,
    inherited,
    mail,
  };
}
