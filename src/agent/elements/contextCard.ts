import { contextUsageOf } from '@/agent/elements/composerContext';
import type { ContextUseState } from '@/agent/useContextUse';
import {
  CONTEXT_WORDS,
  contextFigure,
  contextShare,
  contextTokens,
  type ContextCategoryItem,
  type ContextUsage,
} from '@/components/ai/Context';
import type { RailSectionState } from '@/components/ai/Rail';
import {
  readContextBreakdown,
  type ContextAutocompact,
  type ContextBreakdown,
  type ContextMcpServer,
} from '@/engine/ai/contextBreakdown';
import { instantText } from '@/engine/whenText';

/**
 * The rail's Context card (M92.14, §2): how full the conversation's context
 * is, and, where Claude Code's own breakdown came with the reading, what it
 * holds row by row, each MCP server's part, autocompact and the memory
 * files. Pure.
 *
 * It reads what the composer's pull read (`useContextUse`), never a second
 * pull, and its figure is `contextUsageOf`'s, so the card and the composer's
 * ring say one thing (O3): where a breakdown gives Claude Code's total and
 * window, the pull already made them the reading's. Nothing here keeps a
 * reading (Q7).
 *
 * What it says (CV-05, CV-44): a conversation with no session has had no
 * turn; a session with nothing filed is not recorded; a read that failed is
 * unavailable. A reading with no breakdown is the count alone, partial, as
 * is one with no window. While the pull waits for a session's first answer
 * the card makes no claim. A reading says when it was read, or, while a turn
 * streams, that it is the previous turn's.
 */

/** The card's words. */
export const RAIL_CONTEXT_WORDS = {
  title: 'Context',
  noTurns: 'No turns yet',
  notRecorded: CONTEXT_WORDS.notRecorded,
  notRecordedDetail: "It's read when a turn ends.",
  unavailable: CONTEXT_WORDS.unavailable,
  noBreakdown: 'Breakdown not recorded for this turn',
  noWindow: CONTEXT_WORDS.windowNotRecorded,
  read: 'Read when the last turn ended',
  previous: 'From the previous turn',
  model: 'Model',
  autocompact: 'Autocompact',
  autocompactAt: (threshold: string) => `at ${threshold} tokens`,
  on: 'on',
  off: 'off',
  memoryFiles: 'Memory files',
  none: 'None',
  servers: 'MCP servers',
  serversNotRecorded: 'MCP servers not recorded',
  serversMore: (count: number) => `${count} more ${count === 1 ? 'server' : 'servers'} not shown`,
  tools: (tools: number, loaded: number) => {
    const offered = `${tools} ${tools === 1 ? 'tool' : 'tools'}`;
    return loaded === 0 || loaded === tools ? offered : `${offered}, ${loaded} loaded`;
  },
  notLoaded: CONTEXT_WORDS.notLoaded,
  notRecordedValue: CONTEXT_WORDS.valueNotRecorded,
} as const;

/** One fact under the rows: a term and its value in words. */
export interface RailContextFact {
  term: string;
  value: string;
}

/** One MCP server's line. */
export interface RailContextServer {
  key: string;
  name: string;
  /** How many tools it offers, and how many are loaded when not all. */
  tools: string;
  /** What its loaded tools take; "not loaded" with none loaded, never 0. */
  value: string;
  /** None of its tools is loaded. */
  deferred: boolean;
}

/** The servers' part, or that the breakdown said nothing of them. */
export type RailContextServers =
  | { state: 'listed'; rows: readonly RailContextServer[]; more: string | null }
  | { state: 'not-recorded' };

/** When the reading was read: its words, and the stamp on the reader's
 *  clock, with the instant itself for a `<time>`. */
export interface RailContextFreshness {
  words: string;
  at: string;
  time: string;
}

export interface RailContext {
  /** The card's state (CV-44), or `reading` while the pull waits for the
   *  session's first answer: a claim made then could be wrong a moment
   *  later, so the card makes none. */
  state: RailSectionState | 'reading';
  /** What the heading line says after the name: how full ("62% used"), or
   *  the count with no window ("41.2K tokens"). */
  count: string | null;
  /** What an empty card says after its name. */
  none: string;
  /** The reading as the composer's ring draws it: the one figure. */
  usage: ContextUsage;
  /** The tokens in words: "15,247 of 200,000 tokens". */
  figure: string | null;
  /** The window the rows share, when reported. */
  window: number | null;
  /** Why the card shows less than the whole, in its words. */
  notes: readonly string[];
  /** What the context holds, row by row; null with no breakdown. */
  categories: readonly ContextCategoryItem[] | null;
  /** Rows past what the meter kept, counted. */
  categoriesMore: number;
  facts: readonly RailContextFact[];
  /** Null with no breakdown, and with servers none listed: an empty lane
   *  stays quiet (Q7). */
  servers: RailContextServers | null;
  freshness: RailContextFreshness | null;
}

const counts = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

const settled = (state: RailContext['state'], usage: ContextUsage): RailContext => ({
  state,
  count: null,
  none: RAIL_CONTEXT_WORDS.none,
  usage,
  figure: null,
  window: null,
  notes: [],
  categories: null,
  categoriesMore: 0,
  facts: [],
  servers: null,
  freshness: null,
});

const NO_TURNS: RailContext = {
  ...settled('empty', { state: 'not_recorded' }),
  none: RAIL_CONTEXT_WORDS.noTurns,
};
const READING = settled('reading', { state: 'not_recorded' });
const NOT_RECORDED = settled('not-recorded', { state: 'not_recorded' });
const UNAVAILABLE = settled('unavailable', { state: 'unavailable' });

function autocompactWords(autocompact: ContextAutocompact | undefined): string {
  if (autocompact === undefined) return RAIL_CONTEXT_WORDS.notRecordedValue;
  if (!autocompact.enabled) return RAIL_CONTEXT_WORDS.off;
  return autocompact.threshold === undefined
    ? RAIL_CONTEXT_WORDS.on
    : RAIL_CONTEXT_WORDS.autocompactAt(counts.format(autocompact.threshold));
}

function memoryWords(files: number | undefined): string {
  if (files === undefined) return RAIL_CONTEXT_WORDS.notRecordedValue;
  return files === 0 ? RAIL_CONTEXT_WORDS.none : counts.format(files);
}

/** What a server's loaded tools take: none loaded is not loaded, never 0. */
function serverWords(server: ContextMcpServer): string {
  if (server.loaded === 0) return RAIL_CONTEXT_WORDS.notLoaded;
  return server.tokens === undefined
    ? RAIL_CONTEXT_WORDS.notRecordedValue
    : compact.format(server.tokens);
}

function serverRow(server: ContextMcpServer, index: number): RailContextServer {
  return {
    key: `${index}`,
    name: server.name,
    tools: RAIL_CONTEXT_WORDS.tools(server.tools, server.loaded),
    value: serverWords(server),
    deferred: server.loaded === 0,
  };
}

function serversOf(breakdown: ContextBreakdown): RailContextServers | null {
  const { mcpServers, mcpServersMore = 0 } = breakdown;
  if (mcpServers === undefined) return { state: 'not-recorded' };
  if (mcpServers.length === 0 && mcpServersMore === 0) return null;
  return {
    state: 'listed',
    rows: mcpServers.map(serverRow),
    more: mcpServersMore > 0 ? RAIL_CONTEXT_WORDS.serversMore(mcpServersMore) : null,
  };
}

/** Each reading's card, by whether a turn streams: the pull holds one
 *  reading until the next lands, so a turn's stream, which changes
 *  neither, hands the rail the same card. */
const kept = {
  live: new WeakMap<object, RailContext>(),
  still: new WeakMap<object, RailContext>(),
};

/**
 * The card for what the composer's pull read of `session`. `streaming`: a
 * turn of the conversation is under way, so a reading is the previous
 * turn's.
 */
export function railContext(
  reading: ContextUseState,
  { session, streaming }: { session: string | null; streaming: boolean },
): RailContext {
  if (session === null) return NO_TURNS;
  if (reading.state === 'loading') return READING;
  if (reading.state === 'not_recorded') return NOT_RECORDED;
  const book = streaming ? kept.live : kept.still;
  let card = book.get(reading);
  if (card === undefined) {
    card = cardOf(reading, streaming);
    book.set(reading, card);
  }
  return card;
}

/** The card for a reading the pull answered. */
function cardOf(reading: ContextUseState, streaming: boolean): RailContext {
  const usage = contextUsageOf(reading);
  if (reading.state !== 'recorded' || usage.state !== 'recorded') return UNAVAILABLE;
  const breakdown = readContextBreakdown(reading.breakdown);
  const window = usage.window ?? null;
  const share = contextShare(usage);
  const notes: string[] = [];
  if (breakdown === null) notes.push(RAIL_CONTEXT_WORDS.noBreakdown);
  if (window === null) notes.push(RAIL_CONTEXT_WORDS.noWindow);
  const figure = contextFigure(usage);
  const model = usage.model ?? breakdown?.model ?? null;
  const facts: RailContextFact[] = [
    { term: RAIL_CONTEXT_WORDS.model, value: model ?? RAIL_CONTEXT_WORDS.notRecordedValue },
  ];
  if (breakdown !== null) {
    facts.push(
      { term: RAIL_CONTEXT_WORDS.autocompact, value: autocompactWords(breakdown.autocompact) },
      { term: RAIL_CONTEXT_WORDS.memoryFiles, value: memoryWords(breakdown.memoryFiles) },
    );
  }
  return {
    state: notes.length === 0 ? 'ready' : 'partial',
    count: figure === null ? null : share === null ? `${figure} tokens` : `${figure} used`,
    none: RAIL_CONTEXT_WORDS.none,
    usage,
    figure: contextTokens(usage),
    window,
    notes,
    categories:
      breakdown?.categories.map((row, index) => ({
        key: `${index}`,
        name: row.name,
        kind: row.kind,
        tokens: row.tokens ?? null,
      })) ?? null,
    categoriesMore: breakdown?.categoriesMore ?? 0,
    facts,
    servers: breakdown === null ? null : serversOf(breakdown),
    freshness: {
      words: streaming ? RAIL_CONTEXT_WORDS.previous : RAIL_CONTEXT_WORDS.read,
      at: reading.at,
      time: instantText(reading.at),
    },
  };
}
