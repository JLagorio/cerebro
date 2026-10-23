/**
 * `shared/policy/tool-approval.v1.json` — what Claude Code may run, TS side
 * (M57.2).
 *
 * The SAME FILE the Rust core compiles in with `include_str!`, imported
 * verbatim by vite. Whether one of the CLI's own tools runs, asks the person
 * or is refused is decided by that table alone, by the tool's family (the
 * tool manifest's `family` column), the run's kind and its ceiling, and so,
 * since M57.4, is whether an ask-first agent's page write asks: the
 * manifest's `confirmable` rows resolve to the family the `ask_first` block
 * names, read by the agent's `ask-first:` instead of a ceiling (since M57.4c
 * an unattended one queues for Review, the `queue` decision), since M57.3,
 * whether AskUserQuestion asks the person with a question card, and, since
 * M57.7, whether a run holds WebFetch and WebSearch, by the web ceiling, and,
 * since M60.8b, which vault folders (`hidden_paths`, the Trash) the CLI's own
 * readers and editors may not open. Since M91.1 a run holds only the
 * built-ins its plan admits (`tools`, its `--tools`), the subagent tool only
 * where a gate sits (`needs_gate`), and ToolSearch, which only loads other
 * tools (`loads_tools`), on every run. Since M91.2a the subagent tool reads
 * its own ceiling, the Subagents switch (`delegate`), a record that narrows
 * its tools without naming it is denied it (`narrowed_out`), and a run that
 * holds it names the agent types it may start and the built-in ones its argv
 * denies (`agent_types`). This module is its second
 * interpreter (the critical.ts precedent): the same
 * strict load, refusal for refusal and in the same words, `plan` for a run,
 * and `hostAnswer` for one call. Nothing here restates a decision; the
 * parity is the shared goldens in `shared/policy/goldens-tool-approval/`,
 * which cargo and vitest both replay.
 *
 * No DOM, no store, no React: engine/ reads it, and tsconfig.engine.json
 * typechecks it without the DOM. It imports nothing from engine/, so the
 * name test a narrowing needs arrives as a predicate (`toolGrant.namesTool`).
 *
 * @see src-tauri/src/policy/tool_approval.rs — the Rust interpreter, rule for rule.
 */

import raw from '../../../shared/policy/tool-approval.v1.json';
import { cliTool, TOOLS, type CliTool, type ToolsManifest } from './tools';

export const TOOL_APPROVAL_PATH = 'shared/policy/tool-approval.v1.json';
export const TOOL_APPROVAL_DIGEST_PATH = 'shared/policy/tool-approval.v1.sha256';

/** The format this build reads. */
export const FORMAT = 1;

/** The longest subject a card names, in characters; a longer one is cut and
 * ends in an ellipsis. A cut subject is for display only: no This
 * conversation grant ever covers one (`subjectIsCut`), so two calls that
 * share the first SUBJECT_CHARS characters never share a grant. */
export const SUBJECT_CHARS = 2000;

/** The Settings shell ceiling: off, ask or on. */
export type ShellCeiling = 'off' | 'ask' | 'on';
export const SHELL_CEILINGS: readonly ShellCeiling[] = ['off', 'ask', 'on'];

/** The Settings web ceiling (M57.7): off or on, two states. */
export type WebCeiling = 'off' | 'on';
export const WEB_CEILINGS: readonly WebCeiling[] = ['off', 'on'];

/** The axis the web family's grid is read by (M57.7). */
export const WEB_AXIS = 'web';

/** The Settings Subagents switch (M91.2a): off or on, two states. */
export type DelegateCeiling = 'off' | 'on';
export const DELEGATE_CEILINGS: readonly DelegateCeiling[] = ['off', 'on'];

/** The axis the subagent tool's grid is read by (M91.2a). */
export const DELEGATE_AXIS = 'delegate';

/** `queue` (M57.4c) holds an unattended ask-first page write for Review: the
 * ask-first family's alone. */
export type Decision = 'allow' | 'ask' | 'deny' | 'refuse' | 'cli' | 'queue';
const DECISIONS: readonly Decision[] = ['allow', 'ask', 'deny', 'refuse', 'cli', 'queue'];

export type RunKind = 'attended' | 'unattended' | 'internal';
const RUN_KINDS: readonly RunKind[] = ['attended', 'unattended', 'internal'];

const MODES = ['default', 'acceptEdits'];

/** The axis a confirmable family's grid is read by (M57.4). */
export const ASK_FIRST_AXIS = 'ask_first';

/** How long a person's Allow of a write holds, in minutes (Rust's
 * `APPROVAL_MINUTES`). */
export const APPROVAL_MINUTES = 10;

/** Which card draws an ask (M57.4): a question for AskUserQuestion (M57.3). */
export type CardKind = 'permission' | 'write' | 'question';
const CARD_KINDS: readonly CardKind[] = ['permission', 'write', 'question'];

/** What a card lets the person answer an Allow with (M57.4). */
export type CardAnswer = 'once' | 'conversation';
const CARD_ANSWERS: readonly CardAnswer[] = ['once', 'conversation'];

export interface Card {
  title: string;
  kind: CardKind;
  answers: CardAnswer[];
}

/** What a narrowing makes of a tool it leaves out (M91.2a). */
export type NarrowedOut = 'default' | 'deny';
const NARROWED_OUT: readonly NarrowedOut[] = ['default', 'deny'];

export interface Family {
  id: string;
  ceiling: string;
  needs_default_mode: boolean;
  /** Only a run with a gate a person can answer holds these (M91.1): on any
   * other run the decision is deny, whatever the cell says. Absent is
   * false. */
  needs_gate?: boolean;
  /** Its tools only load other tools' schemas (M91.1, ToolSearch), so every
   * run kind leaves them to the CLI. Absent is false. */
  loads_tools?: boolean;
  /** What becomes of its tools when a record narrows its run's tools and
   * names none of them, by name or alias (M91.2a): `deny` whatever the cell
   * says, or the narrowing's own rule. Absent is `default`. */
  narrowed_out?: NarrowedOut;
  grid: Record<string, Record<string, Decision>>;
  card: Card | null;
  message: string | null;
}

export interface Messages {
  person_denied: string;
  withheld: string;
  denied: string;
  unlisted: string;
  mode_mismatch: string;
  /** The init gate's stop for a built-in the manifest has no row for
   * (M91.1); `{tool}` is its name. */
  unknown_tool: string;
  ask_first_unattended: string;
  ask_first_unapproved: string;
  ask_first_declined: string;
  ask_first_reason: string;
  /** The person's Don't answer on a question card (M57.3). */
  question_declined: string;
  /** A question set no card can show (M57.3); `{reason}` is why. */
  question_malformed: string;
  /** An unattended ask-first write, waiting in Review (M57.4c); `{id}`. */
  queued: string;
  /** The same write, already waiting; `{id}` is the waiting one's. */
  queued_already: string;
  /** The agent's queue is full; `{n}` writes already wait. */
  queue_full: string;
  /** The draft is over `queue_limits.input_bytes`; `{max}` is it. */
  queue_too_large: string;
  /** No runtime database to queue into. */
  queue_unavailable: string;
}

/** What Review may hold of one agent's queued writes (M57.4c). */
export interface QueueLimits {
  open_per_actor: number;
  input_bytes: number;
}

/** Where a case's `ask-first:` sits in the scanned record (CV-09). */
export type Held = 'absent' | 'property' | 'relation';
const HELD: readonly Held[] = ['absent', 'property', 'relation'];

export interface AskFirstCase {
  why: string;
  held: Held;
  value: unknown;
  on: boolean;
  warn: boolean;
}

/** The ask-first axis (M57.4): the record key, the family the manifest's
 * confirmable rows resolve to, and the values a record may hold. */
export interface AskFirstBlock {
  record_key: string;
  family: string;
  cases: AskFirstCase[];
}

/** The vault folders the CLI's own tools may not open (M60.8b): each folder
 * one hidden, vault-relative name, each tool a manifest CLI row whose path
 * rule Claude Code applies. Every attended and unattended run denies
 * `Tool(./folder/**)` for each pair. */
export interface HiddenPaths {
  folders: string[];
  tools: string[];
}

/** The agent types of a run that holds a tool the delegate ceiling reads
 * (M91.2a): `builtin` is Claude Code's own, pinned to the types a 2.1.250
 * init lists, which such a run's argv denies by name; `allowed` is
 * Cerebro's own, `subagents.v1.json`'s presets, which it may start. */
export interface AgentTypes {
  builtin: string[];
  allowed: string[];
}

export interface ToolApproval {
  format: number;
  artifact_version: number;
  rule_version: string;
  cli_version: string;
  min_cli_version: string;
  ceilings: Record<string, string[]>;
  run_kinds: { id: string; can_ask: boolean }[];
  decisions: Decision[];
  permission_modes: { internal: string; asks: string; otherwise: string };
  read_scope: Record<string, Decision>;
  hidden_paths: HiddenPaths;
  unattended_hidden_paths: string[];
  families: Family[];
  unlisted: { decision: Decision };
  messages: Messages;
  ask_first: AskFirstBlock;
  queue_limits: QueueLimits;
  /** What a run holding the subagent tool may start (M91.2a). */
  agent_types: AgentTypes;
}

// --- The shape serde reads on the Rust side ---------------------------------

function refusal(subject: string, field: string, problem: string): Error {
  return new Error(`${TOOL_APPROVAL_PATH}: ${subject}: \`${field}\` ${problem}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A struct with exactly `keys`: an unknown field fails, as
 * `deny_unknown_fields` does, and so does a missing one, but for the
 * `optional` keys serde defaults when they are absent. */
function exactly(
  value: unknown,
  where: string,
  keys: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${TOOL_APPROVAL_PATH}: ${where} must be an object`);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key) && !optional.includes(key)) {
      throw new Error(`${TOOL_APPROVAL_PATH}: unknown field \`${key}\``);
    }
  }
  for (const key of keys) {
    if (!(key in value)) throw new Error(`${TOOL_APPROVAL_PATH}: missing field \`${key}\``);
  }
  return value;
}

function checkShape(value: unknown): ToolApproval {
  const top = exactly(value, 'the table', [
    'format',
    'artifact_version',
    'rule_version',
    'cli_version',
    'min_cli_version',
    'ceilings',
    'run_kinds',
    'decisions',
    'permission_modes',
    'read_scope',
    'hidden_paths',
    'unattended_hidden_paths',
    'families',
    'unlisted',
    'messages',
    'ask_first',
    'queue_limits',
    'agent_types',
  ]);
  const decision = (word: unknown) => {
    if (typeof word !== 'string' || !DECISIONS.includes(word as Decision)) {
      throw new Error(`${TOOL_APPROVAL_PATH}: unknown variant ${JSON.stringify(word)}`);
    }
  };
  if (!Array.isArray(top.run_kinds)) throw new Error(`${TOOL_APPROVAL_PATH}: run_kinds`);
  for (const kind of top.run_kinds) exactly(kind, 'a run kind', ['id', 'can_ask']);
  if (!Array.isArray(top.decisions)) throw new Error(`${TOOL_APPROVAL_PATH}: decisions`);
  top.decisions.forEach(decision);
  exactly(top.permission_modes, 'permission_modes', ['internal', 'asks', 'otherwise']);
  if (!isRecord(top.read_scope)) throw new Error(`${TOOL_APPROVAL_PATH}: read_scope`);
  Object.values(top.read_scope).forEach(decision);
  if (
    !Array.isArray(top.unattended_hidden_paths) ||
    !top.unattended_hidden_paths.every((item) => typeof item === 'string')
  )
    throw new Error(`${TOOL_APPROVAL_PATH}: unattended_hidden_paths must be a list of names`);
  const hidden = exactly(top.hidden_paths, 'hidden_paths', ['folders', 'tools']);
  for (const key of ['folders', 'tools'] as const) {
    const list = hidden[key];
    if (!Array.isArray(list) || !list.every((item) => typeof item === 'string')) {
      throw new Error(`${TOOL_APPROVAL_PATH}: hidden_paths.${key} must be a list of names`);
    }
  }
  if (!Array.isArray(top.families)) throw new Error(`${TOOL_APPROVAL_PATH}: families`);
  for (const family of top.families) {
    const row = exactly(
      family,
      'a family',
      ['id', 'ceiling', 'needs_default_mode', 'grid', 'card', 'message'],
      ['needs_gate', 'loads_tools', 'narrowed_out'],
    );
    for (const flag of ['needs_gate', 'loads_tools'] as const) {
      if (row[flag] !== undefined && typeof row[flag] !== 'boolean') {
        throw new Error(`${TOOL_APPROVAL_PATH}: invalid type: ${flag} must be true or false`);
      }
    }
    if (row.narrowed_out !== undefined) {
      if (typeof row.narrowed_out !== 'string') {
        throw new Error(`${TOOL_APPROVAL_PATH}: expected value: narrowed_out must be a word`);
      }
      variant(row.narrowed_out, NARROWED_OUT);
    }
    if (!isRecord(row.grid)) throw new Error(`${TOOL_APPROVAL_PATH}: grid`);
    for (const cells of Object.values(row.grid)) {
      if (!isRecord(cells)) throw new Error(`${TOOL_APPROVAL_PATH}: grid`);
      Object.values(cells).forEach(decision);
    }
    if (row.card !== null) {
      const card = exactly(row.card, 'a card', ['title', 'kind', 'answers']);
      variant(card.kind, CARD_KINDS);
      if (!Array.isArray(card.answers)) throw new Error(`${TOOL_APPROVAL_PATH}: answers`);
      for (const answer of card.answers) variant(answer, CARD_ANSWERS);
    }
  }
  decision(exactly(top.unlisted, 'unlisted', ['decision']).decision);
  exactly(top.messages, 'messages', [
    'person_denied',
    'withheld',
    'denied',
    'unlisted',
    'mode_mismatch',
    'unknown_tool',
    'ask_first_unattended',
    'ask_first_unapproved',
    'ask_first_declined',
    'ask_first_reason',
    'question_declined',
    'question_malformed',
    'queued',
    'queued_already',
    'queue_full',
    'queue_too_large',
    'queue_unavailable',
  ]);
  const limits = exactly(top.queue_limits, 'queue_limits', ['open_per_actor', 'input_bytes']);
  for (const key of ['open_per_actor', 'input_bytes'] as const) {
    if (!Number.isInteger(limits[key]) || (limits[key] as number) < 0) {
      throw new Error(`${TOOL_APPROVAL_PATH}: queue_limits.${key} must be a whole number`);
    }
  }
  const block = exactly(top.ask_first, 'ask_first', ['record_key', 'family', 'cases']);
  if (!Array.isArray(block.cases)) throw new Error(`${TOOL_APPROVAL_PATH}: cases`);
  for (const one of block.cases) {
    variant(exactly(one, 'an ask_first case', ['why', 'held', 'value', 'on', 'warn']).held, HELD);
  }
  const types = exactly(top.agent_types, 'agent_types', ['builtin', 'allowed']);
  for (const key of ['builtin', 'allowed'] as const) {
    const list = types[key];
    if (!Array.isArray(list) || !list.every((item) => typeof item === 'string')) {
      throw new Error(
        `${TOOL_APPROVAL_PATH}: invalid type: agent_types.${key} must be a list of names`,
      );
    }
  }
  return value as ToolApproval;
}

/** A word of a closed list, refused as serde refuses an unknown variant. */
function variant(word: unknown, words: readonly string[]): void {
  if (typeof word !== 'string' || !words.includes(word)) {
    throw new Error(`${TOOL_APPROVAL_PATH}: unknown variant ${JSON.stringify(word)}`);
  }
}

// --- What validation refuses, as tool_approval.rs refuses it ----------------

const VERSION = /^\d+\.\d+\.\d+$/;

/** `[major, minor, patch]` of an `N.N.N` that leads `text`, or null. */
export function versionTriple(text: string): [number, number, number] | null {
  const word = text.trim().split(/\s+/)[0] ?? '';
  const parts = word.split('.');
  if (parts.length !== 3 || !parts.every((part) => /^\d+$/.test(part))) return null;
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

/** The families in the manifest's order of first appearance: the CLI rows'
 * families, then the ask-first family when a row is confirmable (M57.4). */
function manifestFamilies(table: ToolApproval, manifest: ToolsManifest): string[] {
  const seen: string[] = [];
  for (const tool of manifest.cli_tools) {
    if (tool.family !== null && !seen.includes(tool.family)) seen.push(tool.family);
  }
  const confirms = manifest.tools.some((row) => row.confirmable);
  if (confirms && !seen.includes(table.ask_first.family)) seen.push(table.ask_first.family);
  return seen;
}

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value, i) => value === b[i]);

/** Keys in the order a Rust BTreeMap iterates them: byte order. */
const sortedKeys = (record: Record<string, unknown>) =>
  Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

function checkFamily(table: ToolApproval, family: Family, manifest: ToolsManifest): void {
  const subject = `family ${family.id}`;
  const values = table.ceilings[family.ceiling];
  if (values === undefined) throw refusal(subject, 'ceiling', 'names no declared ceiling');
  if (family.ceiling === ASK_FIRST_AXIS && family.id !== table.ask_first.family) {
    throw refusal(
      subject,
      'ceiling',
      "is ask_first, which only the ask_first block's family reads",
    );
  }
  const wanted = [...RUN_KINDS].sort();
  if (!same(sortedKeys(family.grid), wanted)) {
    throw refusal(subject, 'grid', 'must hold every run kind once');
  }
  const sortedValues = [...values].sort();
  for (const kind of sortedKeys(family.grid)) {
    if (!same(sortedKeys(family.grid[kind]), sortedValues)) {
      throw refusal(subject, `grid.${kind}`, `must hold each ${family.ceiling} value once`);
    }
  }
  const writes = manifest.cli_tools.some((tool) => tool.family === family.id && tool.writes);
  if (writes && family.ceiling === 'shell') {
    for (const kind of ['attended', 'unattended']) {
      if (family.grid[kind].off !== 'deny') {
        throw refusal(
          subject,
          `grid.${kind}.off`,
          'must be deny: the family holds a tool that writes',
        );
      }
    }
  }
  if (writes && family.ceiling !== 'shell') {
    throw refusal(subject, 'ceiling', 'must be shell: the family holds a tool that writes');
  }
  const cells = Object.values(family.grid).flatMap((row) => Object.values(row));
  if (family.loads_tools === true) {
    // M91.1: a loader runs nothing itself, and an internal run's deferred
    // Cerebro tools sit behind it, so every run keeps it.
    if (cells.some((d) => d !== 'cli')) {
      throw refusal(
        subject,
        'grid',
        'must leave every run kind to the CLI: its tools only load other tools',
      );
    }
    // needs_gate would deny it wherever no gate sits, whatever the cells say,
    // and narrowed_out deny wherever a record leaves it out (M91.2a).
    if (family.needs_gate === true) {
      throw refusal(
        subject,
        'needs_gate',
        'must be false: a family that loads tools stays with every run',
      );
    }
    if (family.narrowed_out === 'deny') {
      throw refusal(
        subject,
        'narrowed_out',
        'must be default: a family that loads tools stays with every run',
      );
    }
  } else if (Object.values(family.grid.internal).some((d) => d !== 'deny' && d !== 'refuse')) {
    throw refusal(subject, 'grid.internal', 'may only deny or refuse');
  }
  // M57.4c: only a page write can wait in Review.
  if (family.id !== table.ask_first.family && cells.includes('queue')) {
    throw refusal(subject, 'grid', 'may queue only on the ask_first family');
  }
  const asks = cells.includes('ask');
  const refuses = cells.includes('refuse');
  if (family.card === null && asks) throw refusal(subject, 'card', 'is needed: a cell asks');
  if (family.card !== null && !asks) throw refusal(subject, 'card', 'must be null: no cell asks');
  if (family.card !== null && family.card.title.trim() === '') {
    throw refusal(subject, 'card', 'needs a title');
  }
  if (family.card !== null) {
    const answers = family.card.answers;
    const distinct = answers.length <= 1 || answers[0] !== answers[1];
    if (answers[0] !== 'once' || !distinct || answers.length > 2) {
      throw refusal(subject, 'card.answers', 'must be once, then conversation if it is offered');
    }
    if ((family.card.kind === 'write') !== (family.id === table.ask_first.family)) {
      throw refusal(
        subject,
        'card.kind',
        'is write on the ask_first family, and permission or question elsewhere',
      );
    }
  }
  if (family.message === null && refuses) {
    throw refusal(subject, 'message', 'is needed: a cell refuses');
  }
  if (family.message !== null && !refuses) {
    throw refusal(subject, 'message', 'must be null: no cell refuses');
  }
  if (family.message !== null && family.message.trim() === '') {
    throw refusal(subject, 'message', 'must say why');
  }
}

function validate(table: ToolApproval, manifest: ToolsManifest): void {
  if (table.format !== FORMAT) throw refusal('table', 'format', `must be ${FORMAT}`);
  if (table.artifact_version === 0)
    throw refusal('table', 'artifact_version', 'must be at least 1');
  if (!table.rule_version.startsWith('tool-approval/')) {
    throw refusal('table', 'rule_version', 'must read tool-approval/<date>');
  }
  for (const field of ['cli_version', 'min_cli_version'] as const) {
    if (!VERSION.test(table[field])) throw refusal('table', field, 'must be N.N.N');
  }
  if (!same(table.decisions, DECISIONS)) {
    throw refusal(
      'table',
      'decisions',
      'must be allow, ask, deny, refuse, cli, queue, in that order',
    );
  }
  const ceilingKeys = sortedKeys(table.ceilings);
  if (
    !same(ceilingKeys, [ASK_FIRST_AXIS, DELEGATE_AXIS, 'none', 'shell', WEB_AXIS]) ||
    !same(table.ceilings.none, ['any']) ||
    !same(table.ceilings.shell, SHELL_CEILINGS) ||
    !same(table.ceilings[ASK_FIRST_AXIS], ['yes', 'no']) ||
    !same(table.ceilings[WEB_AXIS], WEB_CEILINGS) ||
    !same(table.ceilings[DELEGATE_AXIS], DELEGATE_CEILINGS)
  ) {
    throw refusal(
      'table',
      'ceilings',
      'must be none: [any], shell: [off, ask, on], ask_first: [yes, no], web: [off, on] and delegate: [off, on]',
    );
  }
  if (
    !same(
      table.run_kinds.map((kind) => kind.id),
      RUN_KINDS,
    )
  ) {
    throw refusal('table', 'run_kinds', 'must be attended, unattended, internal, in that order');
  }
  for (const kind of table.run_kinds) {
    if (kind.can_ask !== (kind.id === 'attended')) {
      throw refusal(`run kind ${kind.id}`, 'can_ask', 'is true only for attended');
    }
  }
  for (const field of ['internal', 'asks', 'otherwise'] as const) {
    if (!MODES.includes(table.permission_modes[field])) {
      throw refusal('permission_modes', field, 'must be default or acceptEdits');
    }
  }
  if (table.permission_modes.internal !== 'default' || table.permission_modes.asks !== 'default') {
    throw refusal(
      'permission_modes',
      'asks',
      'and internal must be default: acceptEdits approves writes with no host',
    );
  }
  const declared = manifestFamilies(table, manifest);
  const ours = table.families.map((family) => family.id);
  const missing = declared.find((id) => !ours.includes(id));
  if (missing !== undefined) {
    throw refusal(`family ${missing}`, 'families', "is the manifest's and has no row here");
  }
  const unused = ours.find((id) => !declared.includes(id));
  if (unused !== undefined)
    throw refusal(`family ${unused}`, 'id', 'holds no tool in the manifest');
  if (!same(ours, declared)) throw refusal('table', 'families', "must follow the manifest's order");
  for (const family of sortedKeys(table.read_scope)) {
    if (!ours.includes(family)) throw refusal('read_scope', family, 'names no declared family');
    if (table.read_scope[family] !== 'deny') throw refusal('read_scope', family, 'must be deny');
  }
  if (table.unlisted.decision !== 'cli' && table.unlisted.decision !== 'refuse') {
    throw refusal('unlisted', 'decision', 'must be cli or refuse');
  }
  checkHiddenPaths(table, manifest);
  for (const [at, folder] of table.unattended_hidden_paths.entries()) {
    if (
      folder
        .split('/')
        .some(
          (part) => !part || part === '.' || part === '..' || !/^[A-Za-z0-9._-]+$/.test(part),
        ) ||
      table.unattended_hidden_paths.slice(0, at).includes(folder)
    )
      throw refusal(
        'unattended_hidden_paths',
        'folders',
        'must contain unique plain relative folders',
      );
  }
  for (const family of table.families) checkFamily(table, family, manifest);
  for (const field of ['open_per_actor', 'input_bytes'] as const) {
    if (table.queue_limits[field] === 0) throw refusal('queue_limits', field, 'must be at least 1');
  }
  checkAskFirst(table, manifest);
  checkAgentTypes(table);
}

/** An agent type's name as argv carries it inside `Agent(<name>)` and an
 * init lists it (M91.2a): letters, digits, colons, dots, dashes and
 * underscores, at least one, so no comma, parenthesis or space can split the
 * rule or end it early. `subagents.v1.json`'s presets are held to it too. */
export function isAgentType(name: string): boolean {
  return /^[A-Za-z0-9:._-]+$/.test(name);
}

/** The agent types (M91.2a), as tool_approval.rs's `check_agent_types`: each
 * one a name argv carries whole, none twice in its list, and none allowed
 * that is one of Claude Code's built-in types, which argv denies. */
function checkAgentTypes(table: ToolApproval): void {
  const types = table.agent_types;
  for (const [field, names] of [
    ['agent_types.builtin', types.builtin],
    ['agent_types.allowed', types.allowed],
  ] as const) {
    names.forEach((name, at) => {
      const problem = !isAgentType(name)
        ? 'must be one or more letters, digits, colons, dots, dashes or underscores'
        : names.slice(0, at).includes(name)
          ? 'is named twice'
          : null;
      if (problem !== null) throw refusal(`agent type ${JSON.stringify(name)}`, field, problem);
    });
  }
  const builtin = types.allowed.find((name) => types.builtin.includes(name));
  if (builtin !== undefined) {
    throw refusal(
      `agent type ${JSON.stringify(builtin)}`,
      'agent_types.allowed',
      "is one of Claude Code's built-in types, which argv denies",
    );
  }
}

/** The hidden folders (M60.8b), as tool_approval.rs's `check_hidden_paths`:
 * each one hidden, vault-relative name whose rule rides argv intact, and
 * each tool a manifest CLI row, none twice. */
function checkHiddenPaths(table: ToolApproval, manifest: ToolsManifest): void {
  const hidden = table.hidden_paths;
  hidden.folders.forEach((name, at) => {
    const problem =
      name === ''
        ? 'must not be empty'
        : /^[/\\]/.test(name) || [...name][1] === ':'
          ? 'must be relative to the vault, never absolute'
          : name.split(/[/\\]/).includes('..')
            ? 'must not climb out of the vault with ..'
            : /[/\\]/.test(name)
              ? 'must be one folder name, without a slash'
              : !name.startsWith('.') || name === '.'
                ? "must be a hidden name: a dot, then the folder's name"
                : !/^[A-Za-z0-9._-]+$/.test(name)
                  ? 'must hold only letters, digits, dots, dashes and underscores'
                  : hidden.folders.slice(0, at).includes(name)
                    ? 'is named twice'
                    : null;
    if (problem !== null) {
      throw refusal(`hidden path ${JSON.stringify(name)}`, 'hidden_paths.folders', problem);
    }
  });
  if (hidden.folders.length > 0 && hidden.tools.length === 0) {
    throw refusal('hidden_paths', 'tools', 'must name a tool when a folder is hidden');
  }
  hidden.tools.forEach((tool, at) => {
    const subject = `hidden path tool ${JSON.stringify(tool)}`;
    if (!manifest.cli_tools.some((row) => row.name === tool)) {
      throw refusal(subject, 'hidden_paths.tools', 'is no CLI tool in the manifest');
    }
    if (hidden.tools.slice(0, at).includes(tool)) {
      throw refusal(subject, 'hidden_paths.tools', 'is named twice');
    }
  });
}

/** The path rules every attended and unattended run denies (M60.8b), as
 * tool_approval.rs's `hidden_path_rules`: `Tool(./folder/**)` for each hidden
 * folder, then each of its tools. */
export function hiddenPathRules(table: ToolApproval = TOOL_APPROVAL): string[] {
  const { folders, tools } = table.hidden_paths;
  return folders.flatMap((folder) => tools.map((tool) => `${tool}(./${folder}/**)`));
}

export function unattendedPathRules(table: ToolApproval = TOOL_APPROVAL): string[] {
  return table.unattended_hidden_paths.flatMap((folder) =>
    table.hidden_paths.tools.map((tool) => `${tool}(./${folder}/**)`),
  );
}

/** The ask-first block (M57.4), as tool_approval.rs's `check_ask_first`. */
function checkAskFirst(table: ToolApproval, manifest: ToolsManifest): void {
  const block = table.ask_first;
  if (block.record_key.trim() === '') {
    throw refusal('ask_first', 'record_key', 'must name a record key');
  }
  const family = table.families.find((row) => row.id === block.family);
  if (family === undefined) throw refusal('ask_first', 'family', 'names no declared family');
  if (family.ceiling !== ASK_FIRST_AXIS) {
    throw refusal('ask_first', 'family', 'must name the family read by ask_first');
  }
  if (manifest.cli_tools.some((tool) => tool.family === block.family)) {
    throw refusal(
      `family ${block.family}`,
      'families',
      "holds a CLI tool: its members are the manifest's confirmable rows",
    );
  }
  if (block.cases.length === 0) {
    throw refusal('ask_first', 'cases', 'must hold at least one case');
  }
  block.cases.forEach((one, at) => {
    const subject = `ask_first case ${at}`;
    const shaped =
      one.held === 'absent'
        ? one.value === null
        : one.held === 'relation'
          ? Array.isArray(one.value) && one.value.every((item) => typeof item === 'string')
          : true;
    if (!shaped) {
      throw refusal(
        subject,
        'value',
        'must be null when absent and a list of names when a relation',
      );
    }
    if (one.warn && !one.on) throw refusal(subject, 'warn', 'is only for a value read as on');
    if (one.why.trim() === '') throw refusal(subject, 'why', 'must say why');
  });
}

/** Parse and fully validate a table against `manifest`. */
export function parseToolApproval(value: unknown, manifest: ToolsManifest = TOOLS): ToolApproval {
  const table = checkShape(value);
  validate(table, manifest);
  return table;
}

/** The shipped table, validated once at module load. */
export const TOOL_APPROVAL: ToolApproval = parseToolApproval(raw);

/** What the model and the person read (M57.2). */
export const APPROVAL_MESSAGES: Messages = TOOL_APPROVAL.messages;

/** What Review may hold of one agent's queued writes (M57.4c). */
export const QUEUE_LIMITS: QueueLimits = TOOL_APPROVAL.queue_limits;

/** What the model reads for a question set no card can show (M57.3): the
 * table's words with `reason` in its parentheses, its closing stop dropped,
 * as tool_approval.rs's `question_malformed`. */
export function questionMalformed(reason: string): string {
  return APPROVAL_MESSAGES.question_malformed.replace('{reason}', reason.replace(/\.+$/, ''));
}

// --- The ceiling --------------------------------------------------------------

/** A stored or wire ceiling: "ask" and "on" exactly, and anything else,
 * a boolean included, is off. */
export function parseShellCeiling(value: unknown): ShellCeiling {
  return value === 'ask' || value === 'on' ? value : 'off';
}

/** A stored or wire web ceiling (M57.7): true or "on" is on, and anything
 * else is off. */
export function parseWebCeiling(value: unknown): WebCeiling {
  return value === true || value === 'on' ? 'on' : 'off';
}

/** A stored or wire Subagents switch (M91.2a), as tool_approval.rs's
 * `DelegateCeiling::read`: "on" exactly is on, and anything else, a boolean
 * included, is off. */
export function parseDelegateCeiling(value: unknown): DelegateCeiling {
  return value === 'on' ? 'on' : 'off';
}

/** A run's Subagents switch, as tool_approval.rs's `DelegateCeiling::of`
 * reads a request's: absent is on where a person watches, the switch's
 * default, and off everywhere else. Only a run with a gate can hold the
 * subagent tool anyway (`needs_gate`). */
export function delegateCeilingOf(
  delegate: DelegateCeiling | null | undefined,
  attended: boolean,
): DelegateCeiling {
  return delegate ?? (attended ? 'on' : 'off');
}

/** What an agent's run may hold: `declared` is whether its record declares
 * the shell (`tools: shell`), null for a run with no record. No record runs
 * at the ceiling; a record that does not declare it gets off; one that does
 * gets the ceiling. */
export function effectiveCeiling(ceiling: ShellCeiling, declared: boolean | null): ShellCeiling {
  if (declared === null) return ceiling;
  return declared ? ceiling : 'off';
}

/** The card a family's ask shows, or null for a family that never asks. */
export function familyCard(id: string, table: ToolApproval = TOOL_APPROVAL): Card | null {
  return table.families.find((family) => family.id === id)?.card ?? null;
}

/** Does `family`'s card offer This conversation? Policy (M57.4). */
export function offersConversation(family: string, table: ToolApproval = TOOL_APPROVAL): boolean {
  return familyCard(family, table)?.answers.includes('conversation') ?? false;
}

// --- A run's plan ---------------------------------------------------------------

export interface ApprovalInput {
  kind: RunKind;
  shell: ShellCeiling;
  /** The web ceiling (M57.7). Absent reads off, as Rust's `web: None` does.
   * Read scope leaves it alone: a read limit bounds vault folders, not the
   * outside world. */
  web?: WebCeiling;
  /** The Subagents switch (M91.2a). Absent reads as `delegateCeilingOf` reads
   * a request's: on for an attended run, off for any other. Read scope leaves
   * it alone too: a subagent reads under its run's own grant. */
  delegate?: DelegateCeiling;
  /** Does the run's agent ask before its page writes (M57.4)? Absent reads
   * as no, as for a run no agent answers (the prompt grant's plan). */
  askFirst?: boolean;
  readScoped: boolean;
  /** Does the record's narrowing name this CLI tool? Null narrows nothing. */
  narrowing: ((tool: string) => boolean) | null;
}

export interface ToolDecision {
  tool: string;
  family: string;
  decision: Decision;
}

/** What a run's argv and its gate take from the table, in manifest order. */
export interface RunApproval {
  permission_mode: string;
  /** `--tools` (M91.1): the only built-ins the run holds, each CLI row the
   * plan allows, asks for or leaves to the CLI, by its name. */
  tools: string[];
  allowed: string[];
  disallowed: string[];
  asks: string[];
  refused: string[];
  withheld: string[];
  /** Claude Code's built-in agent types, which a run holding the subagent
   * tool denies by name (M91.2a); empty on a run without it. */
  denied_agent_types: string[];
  /** The agent types a run holding the subagent tool may start, Cerebro's
   * own (M91.2a); empty on a run without it. */
  allowed_agent_types: string[];
  decisions: ToolDecision[];
}

/** The tools a run's hook must match: the asks, then the refusals. */
export function matcherOf(approval: RunApproval): string[] {
  return [...approval.asks, ...approval.refused];
}

/** Does the narrowing name the CLI row `tool`, by its name or an alias
 * (M91.1)? A record written for `Task` still names the subagent row. */
function namesRow(narrowing: (tool: string) => boolean, tool: CliTool): boolean {
  return narrowing(tool.name) || (tool.aliases ?? []).some((alias) => narrowing(alias));
}

/** What a narrowing makes of `decision`, a tool of `family` it leaves out,
 * as tool_approval.rs's `narrowed_out`: deny where the family's
 * `narrowed_out` says so (M91.2a); else an ask or a queue is denied, so is an
 * allow acceptEdits would approve, any other allow is left to the CLI, and
 * the rest stands. */
function narrowedOut(family: Family, decision: Decision): Decision {
  if (family.narrowed_out === 'deny') return 'deny';
  if (decision === 'ask' || decision === 'queue') return 'deny';
  if (decision === 'allow') return family.needs_default_mode ? 'deny' : 'cli';
  return decision;
}

/** The plan for one run, in tool_approval.rs's order: the cell, the read
 * scope, the narrowing (a family whose `narrowed_out` is deny denies what it
 * leaves out, M91.2a), then what a run that cannot ask does instead, a
 * family that needs a gate denied among it (M91.1). Allow, ask and cli fill
 * `tools`, the run's `--tools` (M91.1), and a run that holds a tool the
 * delegate ceiling reads names the agent types (M91.2a). The
 * manifest's confirmable rows follow the CLI's by the same steps, read by
 * `askFirst` (M57.4); only their asks reach the lists, a queued one rides
 * neither (M57.4c), a narrowed-out one is denied rather than queued, and a
 * run that cannot ask withholds nothing for them. An attended or unattended
 * run's `disallowed` ends with the hidden folders' path rules (M60.8b); an
 * internal run's needs none, since it holds no CLI tool that opens a file. */
export function plan(input: ApprovalInput, table: ToolApproval = TOOL_APPROVAL): RunApproval {
  const canAsk = table.run_kinds.find((kind) => kind.id === input.kind)?.can_ask ?? false;
  const approval: RunApproval = {
    permission_mode: '',
    tools: [],
    allowed: [],
    disallowed: [],
    asks: [],
    refused: [],
    withheld: [],
    denied_agent_types: [],
    allowed_agent_types: [],
    decisions: [],
  };
  const delegate = delegateCeilingOf(input.delegate, input.kind === 'attended');
  let defaultMode = false;
  let startsAgents = false;
  for (const tool of TOOLS.cli_tools) {
    const family = table.families.find((row) => row.id === tool.family);
    if (family === undefined) continue;
    const value =
      family.ceiling === 'shell'
        ? input.shell
        : family.ceiling === WEB_AXIS
          ? (input.web ?? 'off')
          : family.ceiling === DELEGATE_AXIS
            ? delegate
            : 'any';
    let decision = family.grid[input.kind][value];
    if (input.readScoped && table.read_scope[family.id] !== undefined) {
      decision = table.read_scope[family.id];
    }
    if (input.narrowing !== null && !namesRow(input.narrowing, tool)) {
      decision = narrowedOut(family, decision);
    }
    if (!canAsk) {
      if (decision === 'ask') {
        approval.withheld.push(tool.name);
        decision = 'deny';
      } else if (decision === 'refuse' || family.needs_gate === true) {
        decision = 'deny';
      }
    }
    if (decision === 'allow' || decision === 'ask' || decision === 'cli') {
      approval.tools.push(tool.name);
      startsAgents ||= family.ceiling === DELEGATE_AXIS;
    }
    if (decision === 'allow') approval.allowed.push(tool.name);
    if (decision === 'deny') approval.disallowed.push(tool.name);
    if (decision === 'ask') {
      approval.asks.push(tool.name);
      defaultMode ||= family.needs_default_mode;
    }
    if (decision === 'refuse') approval.refused.push(tool.name);
    approval.decisions.push({ tool: tool.name, family: family.id, decision });
  }
  if (startsAgents) {
    approval.denied_agent_types = [...table.agent_types.builtin];
    approval.allowed_agent_types = [...table.agent_types.allowed];
  }
  if (input.kind === 'unattended') approval.disallowed.push(...unattendedPathRules(table));
  if (input.kind !== 'internal') approval.disallowed.push(...hiddenPathRules(table));
  const askFamily = table.families.find((row) => row.id === table.ask_first.family);
  if (askFamily !== undefined) {
    const value = input.askFirst === true ? 'yes' : 'no';
    for (const row of TOOLS.tools.filter((one) => one.confirmable)) {
      const tool = `mcp__${TOOLS.server}__${row.name}`;
      let decision = askFamily.grid[input.kind][value];
      if (input.readScoped && table.read_scope[askFamily.id] !== undefined) {
        decision = table.read_scope[askFamily.id];
      }
      if (input.narrowing !== null && !input.narrowing(tool)) {
        decision = narrowedOut(askFamily, decision);
      }
      if (
        !canAsk &&
        (askFamily.needs_gate === true || decision === 'ask' || decision === 'refuse')
      ) {
        decision = 'deny';
      }
      if (decision === 'ask') {
        approval.asks.push(tool);
        defaultMode ||= askFamily.needs_default_mode;
      }
      approval.decisions.push({ tool, family: askFamily.id, decision });
    }
  }
  const modes = table.permission_modes;
  approval.permission_mode =
    input.kind === 'internal' ? modes.internal : defaultMode ? modes.asks : modes.otherwise;
  return approval;
}

// --- The host's answer for one call ---------------------------------------------

export type HostAnswer =
  | { kind: 'pass' }
  | { kind: 'allow' }
  | { kind: 'deny'; message: string }
  | { kind: 'ask'; family: string; subject: string };

/** What a card names a call by: the manifest's subject field when the input
 * holds it as text, else the whole input as compact JSON; cut at
 * SUBJECT_CHARS characters, ending in an ellipsis when cut. */
export function subjectOf(tool: string, input: unknown): string {
  const field = cliTool(tool)?.subject ?? null;
  const named = field !== null && isRecord(input) ? input[field] : undefined;
  const text = typeof named === 'string' ? named : (JSON.stringify(input ?? null) ?? 'null');
  const chars = [...text];
  return chars.length <= SUBJECT_CHARS ? text : `${chars.slice(0, SUBJECT_CHARS).join('')}…`;
}

/** Was `subject` cut by `subjectOf`? Only a cut subject runs past
 * SUBJECT_CHARS characters (it is SUBJECT_CHARS plus the ellipsis), so the
 * text alone says. A cut subject names only a prefix of the call, so it is
 * never granted, remembered or matched for This conversation, as
 * tool_approval.rs's `subject_is_cut` says. */
export function subjectIsCut(subject: string): boolean {
  return [...subject].length > SUBJECT_CHARS;
}

/** The gate's answer for a call to `tool` with `input`, under `approval`:
 * allow, cli and queue pass (dispatch queues, M57.4c); deny says the
 * family's message where it has one (the question family's says nobody is
 * watching, M57.3), else that the settings forbid it; refuse says the
 * family's message; ask allows only on a grant for this exact subject, where
 * the family's card offers This conversation and the subject was not cut. */
export function hostAnswer(
  approval: RunApproval,
  granted: (family: string, subject: string) => boolean,
  tool: string,
  input: unknown,
  table: ToolApproval = TOOL_APPROVAL,
): HostAnswer {
  // A built-in answers by its row's name or an alias (M91.1).
  const name = cliTool(tool)?.name ?? tool;
  const row = approval.decisions.find((d) => d.tool === name);
  const decision = row?.decision ?? table.unlisted.decision;
  const message = table.families.find((family) => family.id === row?.family)?.message ?? null;
  switch (decision) {
    // Queue is dispatch's (M57.4c): the gate has no opinion.
    case 'allow':
    case 'cli':
    case 'queue':
      return { kind: 'pass' };
    case 'deny':
      return { kind: 'deny', message: message ?? table.messages.denied };
    case 'refuse':
      return { kind: 'deny', message: message ?? table.messages.unlisted };
    case 'ask': {
      const family = row?.family ?? 'unlisted';
      const subject = subjectOf(tool, input);
      return !subjectIsCut(subject) && offersConversation(family, table) && granted(family, subject)
        ? { kind: 'allow' }
        : { kind: 'ask', family, subject };
    }
  }
}

// --- Ask-first (M57.4) ------------------------------------------------------

/** What an Agent record's `ask-first:` says. */
export interface AskFirst {
  on: boolean;
  warn: boolean;
}

/**
 * An Agent record's `ask-first:`, by the artifact's cases, as
 * tool_approval.rs's `ask_first_of` reads it: absent or `false` reads off;
 * `true` reads on; anything else, a relation included (CV-09), reads on and
 * warns, so an odd value fails closed.
 */
export function askFirstOf(
  properties: Record<string, unknown>,
  relationships: Record<string, string[]>,
  table: ToolApproval = TOOL_APPROVAL,
): AskFirst {
  const key = table.ask_first.record_key;
  const related = Object.hasOwn(relationships, key);
  const value = Object.hasOwn(properties, key) ? properties[key] : undefined;
  if (!related && (value === undefined || value === false)) return { on: false, warn: false };
  if (!related && value === true) return { on: true, warn: false };
  return { on: true, warn: true };
}

/** The decision for a confirmable write in a run no seat holds, as Rust's
 * `confirmable_decision`: a run that cannot ask denies what it would ask,
 * and an unattended ask-first write queues for Review (M57.4c). */
export function confirmableDecision(
  kind: RunKind,
  askFirst: boolean,
  table: ToolApproval = TOOL_APPROVAL,
): Decision {
  const family = table.families.find((row) => row.id === table.ask_first.family);
  if (family === undefined) return 'deny';
  const decision = family.grid[kind][askFirst ? 'yes' : 'no'];
  const canAsk = table.run_kinds.find((row) => row.id === kind)?.can_ask ?? false;
  return !canAsk && (family.needs_gate === true || decision === 'ask' || decision === 'refuse')
    ? 'deny'
    : decision;
}

/** What the model reads when the person declines a write (Rust's
 * `interaction::write_declined`). */
export function writeDeclined(reason: string | null): string {
  const said = reason?.trim() ?? '';
  const declined = APPROVAL_MESSAGES.ask_first_declined;
  return said === ''
    ? declined
    : `${declined} ${APPROVAL_MESSAGES.ask_first_reason.replace('{reason}', said)}`;
}
