/**
 * What a run holds, so its prompt names only that (M54.7).
 *
 * Rust decides what a run may call: `narrow` in src-tauri/src/agent/mod.rs
 * intersects the granted policy with the run's declared tools by one name
 * test, `names_tool` (M54.4), which argv, dispatch and the listing all ask.
 * This module is the TS half of that decision, for the prompts: a line that
 * names a tool the run lacks tells it to plan around a call that will be
 * refused. A twin, allowed by D3 and held to Rust by
 * src-tauri/fixtures/tool-grants.json, which both languages replay. No other
 * TS module decides which tools a run holds.
 *
 * Cerebro's own tools are reckoned by name. The CLI's are reckoned by the
 * tool-approval table (M57.2, `cliGrant`): `PromptGrant.shell` says whether
 * the run can change files itself, pre-approved or by asking the person. A
 * run the app's TS starts never holds a window or an answer tool, which
 * belong to Rust's own runs, and TS cannot read the proposal switch, so the
 * generated proposal tools count as not held and no prompt names them (fail
 * closed).
 *
 * Pure: engine/ reads it, and tsconfig.engine.json typechecks it without the
 * DOM.
 */

import { TOOLS, toolFacts } from '@/lib/policy/tools';
import { plan, TOOL_APPROVAL, type ShellCeiling } from '@/lib/policy/toolApproval';
import { ALL_TOOLS, TOOLSETS } from './tools';

/** What a prompt is composed against. */
export interface PromptGrant {
  /** The cerebro tools the run holds, by their short names. */
  tools: ReadonlySet<string>;
  /** Whether it can change files through the CLI's own tools, pre-approved
   * or by asking the person: its shell ceiling as the tool-approval table
   * plans it (`holdsShell`), less what its record withholds and what a read
   * limit withdraws (M53.5). */
  shell: boolean;
  /** Whether a person is watching it: a panel turn, never a background job. */
  attended: boolean;
}

const SERVER_PREFIX = `mcp__${TOOLS.server}__`;

/** Every cerebro tool a run the app's TS starts can hold: each picker set's
 * tools but the generated proposal set's. */
const HOLDABLE: readonly string[] = TOOLSETS.filter(
  (set) => set.id !== TOOLS.generated.toolset,
).flatMap((set) => set.tools.map((tool) => tool.name));

/** What Rust's `str::trim` strips from each end: the Unicode White_Space set,
 * by code point. Not JavaScript's `trim`, which strips U+FEFF as well and
 * keeps U+0085. */
const RUST_WHITE_SPACE: ReadonlySet<number> = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
  0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

const isRustWhiteSpace = (char: string) => RUST_WHITE_SPACE.has(char.codePointAt(0) ?? -1);

/** A declared entry as `names_tool` hears it: trimmed as Rust trims, and
 * lowercased in ASCII only, as `to_ascii_lowercase` lowercases. */
function heard(entry: string): string {
  const chars = [...entry];
  let start = 0;
  let end = chars.length;
  while (start < end && isRustWhiteSpace(chars[start])) start += 1;
  while (end > start && isRustWhiteSpace(chars[end - 1])) end -= 1;
  return chars
    .slice(start, end)
    .join('')
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/**
 * The cerebro tools a run holds, given its declared tools: null narrows
 * nothing, and an entry names a tool when, heard as `names_tool` hears it, it
 * equals the tool's name with or without the `mcp__cerebro__` prefix. Pass the
 * same narrowing the run sends as `allowedTools`.
 */
export function grantedTools(narrowing: readonly string[] | null): ReadonlySet<string> {
  if (narrowing === null) return new Set(HOLDABLE);
  const wanted = new Set(narrowing.map(heard).filter((name) => name !== ''));
  return new Set(
    HOLDABLE.filter((name) => wanted.has(name) || wanted.has(`${SERVER_PREFIX}${name}`)),
  );
}

/** The one name test, `names_tool` (M54.4): does `declared`, an entry of a
 * run's declared tools, name `tool` as the CLI grants it? Heard as Rust
 * hears it, with or without the `mcp__cerebro__` prefix, which names only
 * cerebro's tools. */
export function namesTool(declared: string, tool: string): boolean {
  const wanted = heard(declared);
  const full = tool.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  const short = full.startsWith(SERVER_PREFIX) ? full.slice(SERVER_PREFIX.length) : full;
  return wanted !== '' && (wanted === full || wanted === short);
}

/** What a run of the app's TS asks the tool-approval table about (M57.2). */
export interface CliGrantInput {
  /** Its effective shell ceiling (`effectiveCeiling`). */
  shell: ShellCeiling;
  /** A person watches it, in the panel: its gate can ask. */
  attended: boolean;
  /** Its record draws a read limit. */
  readScoped: boolean;
  /** Its declared tools, as it sends them as `allowedTools`; null narrows
   * nothing. */
  narrowing: readonly string[] | null;
}

/** The CLI's own tools a run holds (`cli`, pre-approved) and may ask the
 * person for (`asks`), as the tool-approval table plans them, in manifest
 * order. Held to Rust by tool-grants.json's `cli_cases`. */
export function cliGrant(input: CliGrantInput): { cli: string[]; asks: string[] } {
  const narrowing = input.narrowing;
  const approval = plan({
    kind: input.attended ? 'attended' : 'unattended',
    shell: input.shell,
    readScoped: input.readScoped,
    narrowing:
      narrowing === null ? null : (tool) => narrowing.some((entry) => namesTool(entry, tool)),
  });
  return { cli: approval.allowed, asks: approval.asks };
}

/** The families whose tools change things (`needs_default_mode`: the ones
 * acceptEdits would approve with no host). */
const CHANGING_FAMILIES = new Set(
  TOOL_APPROVAL.families.filter((family) => family.needs_default_mode).map((family) => family.id),
);

/** Can the run change files itself: does it hold, or may it ask for, a CLI
 * tool of a family that changes things? */
export function holdsShell(input: CliGrantInput): boolean {
  const { cli, asks } = cliGrant(input);
  return [...cli, ...asks].some((name) => {
    const family = TOOLS.cli_tools.find((tool) => tool.name === name)?.family;
    return family != null && CHANGING_FAMILIES.has(family);
  });
}

/** Does the run hold every one of `names`? */
export function holds(grant: PromptGrant, ...names: readonly string[]): boolean {
  return names.every((name) => grant.tools.has(name));
}

/**
 * The tools that change a note already on disk: the manifest's rows that
 * write and are aimed at a note (today update_frontmatter, append_to_note and
 * edit_note).
 * Read off the manifest, so a new note editor joins without an edit here.
 */
export const NOTE_EDITORS: readonly string[] = HOLDABLE.filter((name) => {
  const facts = toolFacts(name);
  return facts !== null && facts.writes && facts.target?.kind === 'note';
});

/** Can the run change a note on disk: through a note editor it holds, or
 * through the shell's file tools? */
export function editsNotes(grant: PromptGrant): boolean {
  return grant.shell || NOTE_EDITORS.some((name) => grant.tools.has(name));
}

/** Any character an identifier can hold, so a name ends where none follows. */
const IDENTIFIER = '[A-Za-z0-9_]';

function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Any served name at identifier boundaries, `mcp__cerebro__` allowed before
 * it. Longest first, so a scan tries `propose_cache_source` before
 * `cache_source`; the boundaries make the order an economy, not a rule. */
const MENTION = new RegExp(
  `(?<!${IDENTIFIER})(?:${literal(SERVER_PREFIX)})?(${[...new Set(ALL_TOOLS.map((t) => t.name))]
    .sort((a, b) => b.length - a.length)
    .map(literal)
    .join('|')})(?!${IDENTIFIER})`,
  'g',
);

/** A backtick span. */
const CODE_SPAN = /`[^`]*`/g;

/**
 * Every cerebro tool `text` names, sorted: a served name at identifier
 * boundaries, bare or `mcp__cerebro__`-prefixed, so `get_notes` and
 * `xget_note` name no `get_note`. A name with no underscore (today only
 * `navigate`) is an English word as often as it is a tool, so it counts only
 * inside backticks.
 */
export function mentionedTools(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(MENTION)) {
    if (match[1].includes('_')) found.add(match[1]);
  }
  for (const span of text.matchAll(CODE_SPAN)) {
    for (const match of span[0].matchAll(MENTION)) found.add(match[1]);
  }
  return [...found].sort();
}
