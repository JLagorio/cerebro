/**
 * Claude Code's own account of a session's context (M92.14, §4): the rows
 * of its `/context` report, its total and the window it measures that total
 * against, its model, autocompact, each MCP server's tools and what the
 * loaded ones take, and how many memory files it read. Rust's meter reads it
 * from the run's answer to the context ask (`get_context_usage`, M92.13),
 * and `agent_context_usage` carries it beside the session's reading as
 * `breakdown`. Pure: no DOM.
 *
 * It is never trusted as it crosses: `readContextBreakdown` keeps what the
 * meter writes and nothing else. A count that is not a whole number from 0
 * to 2^53 − 1 was not recorded, never 0 (CV-05); a name past `nameChars`
 * characters is cut and marked; past a list's cap the rest are counted,
 * never shown. The memory files' paths and the MCP tools' names never cross
 * at all (Q12, O2). `src-tauri/fixtures/context-breakdown.json` holds both
 * readers to one contract: the meter writes each case's `wire` from its
 * `response`, and this reads that `wire` back whole.
 */

/**
 * What a row is, as Claude Code's own report classes it: content in the
 * window (`used`), the room left (`free`), the reserve compaction keeps
 * (`buffer`), or tool schemas held outside the window until a search loads
 * them (`deferred`), which count toward nothing.
 */
export type ContextCategoryKind = 'used' | 'free' | 'buffer' | 'deferred';

/** One row of the report. */
export interface ContextCategory {
  /** As the report names it: "System prompt", "MCP tools (deferred)". */
  name: string;
  /** Its tokens; absent when Claude Code's count was not a count. */
  tokens?: number;
  kind: ContextCategoryKind;
}

/** One MCP server's part: the tools it offers the session, and what the
 *  loaded ones take. */
export interface ContextMcpServer {
  name: string;
  tools: number;
  /** Of `tools`, how many are loaded into the context; the rest wait
   *  behind tool search. */
  loaded: number;
  /** What the loaded ones take, 0 with none loaded; absent when one of
   *  their counts was not a count. */
  tokens?: number;
}

export interface ContextAutocompact {
  enabled: boolean;
  /** The total at which it compacts; absent when not reported. */
  threshold?: number;
}

export interface ContextBreakdown {
  /** The report's rows, in its order. */
  categories: ContextCategory[];
  /** Rows past the cap, counted, never shown; absent with none. */
  categoriesMore?: number;
  /** The tokens in the context, as Claude Code counts them. */
  total?: number;
  /** The window `total` is measured against. */
  max?: number;
  /** The model the report was computed for. */
  model?: string;
  autocompact?: ContextAutocompact;
  /** Each server the session's MCP tools came from, in the order Claude
   *  Code first listed it. Absent when the answer held no list of them:
   *  not recorded, never none. */
  mcpServers?: ContextMcpServer[];
  /** Servers past the cap, counted, never shown; absent with none. */
  mcpServersMore?: number;
  /** How many memory files the context holds; their paths never cross. */
  memoryFiles?: number;
}

/** The bounds both readers hold (the fixture's `limits`): rows kept per
 *  list, and characters kept per name. */
export const CONTEXT_BREAKDOWN_LIMITS = {
  categories: 64,
  mcpServers: 256,
  nameChars: 128,
} as const;

/** What a cut name ends in. */
const CUT = '…';

const KINDS: ReadonlySet<string> = new Set<ContextCategoryKind>([
  'used',
  'free',
  'buffer',
  'deferred',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A count as the meter writes one: a whole number from 0 to 2^53 − 1, so
 *  it reads the same on both sides of the wire; else null. */
function countOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * A name as the meter writes one: a string of one character or more, cut
 * past `nameChars` characters to its first `nameChars − 1` and an ellipsis.
 * Characters are counted by code point, as Rust counts a `str`'s chars, so
 * a name the meter cut reads back whole. Else null.
 */
function nameOf(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  const chars = Array.from(value);
  const limit = CONTEXT_BREAKDOWN_LIMITS.nameChars;
  return chars.length <= limit ? value : `${chars.slice(0, limit - 1).join('')}${CUT}`;
}

function categoryOf(value: unknown): ContextCategory | null {
  if (!isRecord(value)) return null;
  const name = nameOf(value.name);
  const { kind } = value;
  if (name === null || typeof kind !== 'string' || !KINDS.has(kind)) return null;
  const tokens = countOf(value.tokens);
  const row: ContextCategory = { name, kind: kind as ContextCategoryKind };
  if (tokens !== null) row.tokens = tokens;
  return row;
}

function serverOf(value: unknown): ContextMcpServer | null {
  if (!isRecord(value)) return null;
  const name = nameOf(value.name);
  const tools = countOf(value.tools);
  const loaded = countOf(value.loaded);
  if (name === null || tools === null || loaded === null || loaded > tools) return null;
  const tokens = countOf(value.tokens);
  const row: ContextMcpServer = { name, tools, loaded };
  if (tokens !== null) row.tokens = tokens;
  return row;
}

function autocompactOf(value: unknown): ContextAutocompact | null {
  if (!isRecord(value) || typeof value.enabled !== 'boolean') return null;
  const threshold = countOf(value.threshold);
  return threshold === null ? { enabled: value.enabled } : { enabled: value.enabled, threshold };
}

/** A list's rows that read, the first `cap` of them, and how many are past
 *  it: those the wire said were, and those past it here. A row that does
 *  not read is no row. */
function capped<T>(
  values: readonly unknown[],
  read: (value: unknown) => T | null,
  cap: number,
  said: unknown,
): { rows: T[]; more: number } {
  const rows: T[] = [];
  let more = countOf(said) ?? 0;
  for (const value of values) {
    const row = read(value);
    if (row === null) continue;
    if (rows.length < cap) rows.push(row);
    else more += 1;
  }
  return { rows, more };
}

/**
 * The breakdown `agent_context_usage` carried, as the meter writes it, or
 * null when it is not one: anything but an object holding a list of rows.
 * What does not read is left out, each value on its own, so a count nobody
 * recorded is absent, never 0.
 */
export function readContextBreakdown(value: unknown): ContextBreakdown | null {
  if (!isRecord(value) || !Array.isArray(value.categories)) return null;
  const limits = CONTEXT_BREAKDOWN_LIMITS;
  const categories = capped(value.categories, categoryOf, limits.categories, value.categoriesMore);
  const read: ContextBreakdown = { categories: categories.rows };
  if (categories.more > 0) read.categoriesMore = categories.more;
  const total = countOf(value.total);
  if (total !== null) read.total = total;
  const max = countOf(value.max);
  if (max !== null && max > 0) read.max = max;
  const model = nameOf(value.model);
  if (model !== null) read.model = model;
  const autocompact = autocompactOf(value.autocompact);
  if (autocompact !== null) read.autocompact = autocompact;
  if (Array.isArray(value.mcpServers)) {
    const servers = capped(value.mcpServers, serverOf, limits.mcpServers, value.mcpServersMore);
    read.mcpServers = servers.rows;
    if (servers.more > 0) read.mcpServersMore = servers.more;
  }
  const memoryFiles = countOf(value.memoryFiles);
  if (memoryFiles !== null) read.memoryFiles = memoryFiles;
  return read;
}
