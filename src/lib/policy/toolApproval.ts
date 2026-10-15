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
 * an unattended one queues for Review, the `queue` decision), and, since
 * M57.3, whether AskUserQuestion asks the person with a question card. This
 * module is its second interpreter (the critical.ts precedent): the same
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
import { TOOLS, type ToolsManifest } from './tools';

export const TOOL_APPROVAL_PATH = 'shared/policy/tool-approval.v1.json';
export const TOOL_APPROVAL_DIGEST_PATH = 'shared/policy/tool-approval.v1.sha256';

/** The format this build reads. */
export const FORMAT = 1;

/** The longest subject a card names, in characters; a longer one is cut and
 * ends in an ellipsis. */
export const SUBJECT_CHARS = 2000;

/** The Settings shell ceiling: off, ask or on. */
export type ShellCeiling = 'off' | 'ask' | 'on';
export const SHELL_CEILINGS: readonly ShellCeiling[] = ['off', 'ask', 'on'];

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

export interface Family {
  id: string;
  ceiling: string;
  needs_default_mode: boolean;
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
  families: Family[];
  unlisted: { decision: Decision };
  messages: Messages;
  ask_first: AskFirstBlock;
  queue_limits: QueueLimits;
}

// --- The shape serde reads on the Rust side ---------------------------------

function refusal(subject: string, field: string, problem: string): Error {
  return new Error(`${TOOL_APPROVAL_PATH}: ${subject}: \`${field}\` ${problem}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A struct with exactly `keys`: an unknown field fails, as
 * `deny_unknown_fields` does, and so does a missing one. */
function exactly(value: unknown, where: string, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${TOOL_APPROVAL_PATH}: ${where} must be an object`);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`${TOOL_APPROVAL_PATH}: unknown field \`${key}\``);
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
    'families',
    'unlisted',
    'messages',
    'ask_first',
    'queue_limits',
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
  if (!Array.isArray(top.families)) throw new Error(`${TOOL_APPROVAL_PATH}: families`);
  for (const family of top.families) {
    const row = exactly(family, 'a family', [
      'id',
      'ceiling',
      'needs_default_mode',
      'grid',
      'card',
      'message',
    ]);
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
  if (Object.values(family.grid.internal).some((d) => d !== 'deny' && d !== 'refuse')) {
    throw refusal(subject, 'grid.internal', 'may only deny or refuse');
  }
  const cells = Object.values(family.grid).flatMap((row) => Object.values(row));
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
    !same(ceilingKeys, [ASK_FIRST_AXIS, 'none', 'shell']) ||
    !same(table.ceilings.none, ['any']) ||
    !same(table.ceilings.shell, SHELL_CEILINGS) ||
    !same(table.ceilings[ASK_FIRST_AXIS], ['yes', 'no'])
  ) {
    throw refusal(
      'table',
      'ceilings',
      'must be none: [any], shell: [off, ask, on] and ask_first: [yes, no]',
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
  for (const family of table.families) checkFamily(table, family, manifest);
  for (const field of ['open_per_actor', 'input_bytes'] as const) {
    if (table.queue_limits[field] === 0) throw refusal('queue_limits', field, 'must be at least 1');
  }
  checkAskFirst(table, manifest);
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
  allowed: string[];
  disallowed: string[];
  asks: string[];
  refused: string[];
  withheld: string[];
  decisions: ToolDecision[];
}

/** The tools a run's hook must match: the asks, then the refusals. */
export function matcherOf(approval: RunApproval): string[] {
  return [...approval.asks, ...approval.refused];
}

/** The plan for one run, in tool_approval.rs's order: the cell, the read
 * scope, the narrowing, then what a run that cannot ask does instead. The
 * manifest's confirmable rows follow the CLI's by the same steps, read by
 * `askFirst` (M57.4); only their asks reach the lists, a queued one rides
 * neither (M57.4c), a narrowed-out one is denied rather than queued, and a
 * run that cannot ask withholds nothing for them. */
export function plan(input: ApprovalInput, table: ToolApproval = TOOL_APPROVAL): RunApproval {
  const canAsk = table.run_kinds.find((kind) => kind.id === input.kind)?.can_ask ?? false;
  const approval: RunApproval = {
    permission_mode: '',
    allowed: [],
    disallowed: [],
    asks: [],
    refused: [],
    withheld: [],
    decisions: [],
  };
  let defaultMode = false;
  for (const tool of TOOLS.cli_tools) {
    const family = table.families.find((row) => row.id === tool.family);
    if (family === undefined) continue;
    const value = family.ceiling === 'shell' ? input.shell : 'any';
    let decision = family.grid[input.kind][value];
    if (input.readScoped && table.read_scope[family.id] !== undefined) {
      decision = table.read_scope[family.id];
    }
    if (input.narrowing !== null && !input.narrowing(tool.name)) {
      if (decision === 'ask' || decision === 'queue') decision = 'deny';
      else if (decision === 'allow') decision = family.needs_default_mode ? 'deny' : 'cli';
    }
    if (!canAsk) {
      if (decision === 'ask') {
        approval.withheld.push(tool.name);
        decision = 'deny';
      } else if (decision === 'refuse') {
        decision = 'deny';
      }
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
        if (decision === 'ask' || decision === 'queue') decision = 'deny';
        else if (decision === 'allow') decision = askFamily.needs_default_mode ? 'deny' : 'cli';
      }
      if (!canAsk && (decision === 'ask' || decision === 'refuse')) decision = 'deny';
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
  const field = TOOLS.cli_tools.find((row) => row.name === tool)?.subject ?? null;
  const named = field !== null && isRecord(input) ? input[field] : undefined;
  const text = typeof named === 'string' ? named : (JSON.stringify(input ?? null) ?? 'null');
  const chars = [...text];
  return chars.length <= SUBJECT_CHARS ? text : `${chars.slice(0, SUBJECT_CHARS).join('')}…`;
}

/** The gate's answer for a call to `tool` with `input`, under `approval`:
 * allow, cli and queue pass (dispatch queues, M57.4c); deny says the
 * family's message where it has one (the question family's says nobody is
 * watching, M57.3), else that the settings forbid it; refuse says the family's message; ask allows only on a grant
 * for this exact subject, where the family's card offers This conversation. */
export function hostAnswer(
  approval: RunApproval,
  granted: (family: string, subject: string) => boolean,
  tool: string,
  input: unknown,
  table: ToolApproval = TOOL_APPROVAL,
): HostAnswer {
  const row = approval.decisions.find((d) => d.tool === tool);
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
      return offersConversation(family, table) && granted(family, subject)
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
  return !canAsk && (decision === 'ask' || decision === 'refuse') ? 'deny' : decision;
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
