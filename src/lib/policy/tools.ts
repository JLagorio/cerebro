/**
 * `shared/policy/tools.v1.json` — the one tool manifest, TS side (M54.2).
 *
 * The SAME FILE the Rust core compiles in with `include_str!`, imported
 * verbatim by vite. Every tool cerebro's loopback serves is a row in it, the
 * generated `propose_<op>` tools share one `generated` block, and the CLI's
 * own built-ins are one list. No tool is listed here. What lives in this
 * module is the strict load the Rust loader performs, refusal for refusal and
 * in the same words, and `toolFacts`: what a call writes, how a transcript
 * draws it, its icon and the argument it is aimed by.
 *
 * Load is STRICT, as serde's `deny_unknown_fields` is on the Rust side: an
 * unknown field fails, a missing one fails unless the Rust field is an
 * `Option` (absent then reads as null), and validation refuses a manifest
 * whose facts disagree, naming the row and the field. Both loaders run the
 * same negative controls and replay `src-tauri/fixtures/tool-cases.json`.
 *
 * No DOM, no store, no React: engine/ reads it, and tsconfig.engine.json
 * typechecks it without the DOM.
 *
 * @see src-tauri/src/policy/tools.rs — the Rust loader, kind for kind.
 */

import rawTools from '../../../shared/policy/tools.v1.json';
import { agentFacingOps, POLICY } from './table';

export const TOOLS_PATH = 'shared/policy/tools.v1.json';
export const TOOLS_DIGEST_PATH = 'shared/policy/tools.v1.sha256';

/** The format this build reads. */
export const TOOLS_FORMAT = 1;

/** The longest name a tool may have as the CLI spells it,
 * `mcp__<server>__<name>`, and the longest title. */
const NAME_LIMIT = 64;
const TITLE_LIMIT = 64;

/** A summary this short, or one that only repeats the name, tells the person
 * picking tools nothing. */
const SUMMARY_FLOOR = 10;

/** Search hints are plain search words, not a second description. */
const SEARCH_HINT_LIMIT = 80;

/** The roadmap's bounds on a served description: a thinner one is how an
 * agent picks the wrong tool, and 2048 is the most one may carry. */
const DESCRIPTION_MIN = 21;
const DESCRIPTION_MAX = 2048;

/** Served on every run, or beside the generated tools when the proposal
 * surface is on. */
export type Surface = 'base' | 'proposals';
/** What a call changes, as the annotations say it. */
export type Kind = 'read_only' | 'additive' | 'destructive';
/** Which folder list in a run's grant binds the tool; none means the row's
 * `exempt` says why, and read_write (M55.5) is both, on one note: a writer
 * whose answers quote the note back reads what it writes. */
export type Axis = 'write' | 'read' | 'read_write' | 'none';
/** What a tool's target argument names; the bundle takes no argument. */
export type TargetKind = 'note' | 'folder' | 'concept' | 'source_id' | 'bundle';
/** How a transcript shows a call: a step in the run, or a change card. */
export type Renderer = 'step' | 'change';

const SURFACES: readonly Surface[] = ['base', 'proposals'];
const KINDS: readonly Kind[] = ['read_only', 'additive', 'destructive'];
const AXES: readonly Axis[] = ['write', 'read', 'read_write', 'none'];
const TARGET_KINDS: readonly TargetKind[] = ['note', 'folder', 'concept', 'source_id', 'bundle'];
const RENDERERS: readonly Renderer[] = ['step', 'change'];

/** The text a `{{name}}` in a description or schema stands for. */
export interface Token {
  why: string;
}

/** A way a tool reaches the world, and what that allows. */
export interface Door {
  id: string;
  /** True when a call through this door changes something on disk. */
  writes: boolean;
  kinds: Kind[];
  axes: Axis[];
}

/** One group in the tool picker. */
export interface Toolset {
  id: string;
  label: string;
  hint: string;
}

/** A hand-written tool allowed to carry the generated prefix. */
export interface PrefixException {
  name: string;
  why: string;
}

/** The argument a tool is aimed by, and what it names. */
export interface Target {
  arg: string | null;
  kind: TargetKind;
}

/** One hand-written tool. */
export interface ToolRow {
  name: string;
  surface: Surface;
  /** Served as `annotations.title`. */
  title: string;
  /** The picker's one plain line. */
  summary: string;
  /** Null is never offered in a picker. */
  toolset: string | null;
  kind: Kind;
  idempotent: boolean;
  open_world: boolean;
  door: string;
  axis: Axis;
  target: Target | null;
  /** Why no folder axis binds the tool; set exactly when `axis` is none. */
  exempt: string | null;
  renderer: Renderer;
  /** A lucide icon name. */
  icon: string;
  always_load: boolean;
  search_hint: string;
  description: string;
  input_schema: unknown;
}

/** The facts every generated `propose_<op>` tool shares. */
export interface Generated {
  prefix: string;
  /** A generated title is this, then the op with spaces for underscores. */
  title_prefix: string;
  toolset: string;
  kind: Kind;
  idempotent: boolean;
  open_world: boolean;
  door: string;
  axis: Axis;
  exempt: string | null;
  renderer: Renderer;
  icon: string;
  always_load: boolean;
  search_hint: string;
}

/** One of the CLI's own built-in tools. */
export interface CliTool {
  name: string;
  writes: boolean;
  denied_without_shell: boolean;
  denied_when_read_scoped: boolean;
  /** Granted, with the cerebro tools, to a run that holds shell. */
  with_shell: boolean;
  renderer: Renderer;
  icon: string;
}

export interface ToolsManifest {
  format: number;
  artifact_version: number;
  rule_version: string;
  server: string;
  tokens: Record<string, Token>;
  doors: Door[];
  toolsets: Toolset[];
  prefix_exceptions: PrefixException[];
  /** In served order, which is meaning: nothing sorts it. */
  tools: ToolRow[];
  generated: Generated;
  /** In argv order, which is meaning too. */
  cli_tools: CliTool[];
}

/** A refusal, naming what it is about and the field that is wrong, in the
 * words tools.rs's `refusal` uses. */
function refusal(subject: string, field: string, problem: string): Error {
  return new Error(`${TOOLS_PATH}: ${subject}: \`${field}\` ${problem}`);
}

// --- The shape serde reads on the Rust side --------------------------------
//
// Each struct denies unknown fields, each enum is a closed word list, and an
// `Option` field may be absent, which reads as null.

type Check = (value: unknown, subject: string, field: string) => void;
/** A field's check, or an `Option` around one. */
type Field = Check | { option: Check };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A shape refusal; `field` is empty when the subject itself is malformed. */
function shapeRefusal(subject: string, field: string, problem: string): Error {
  return field === ''
    ? new Error(`${TOOLS_PATH}: ${subject}: ${problem}`)
    : refusal(subject, field, problem);
}

const text: Check = (value, subject, field) => {
  if (typeof value !== 'string') throw shapeRefusal(subject, field, 'must be a string');
};

const flag: Check = (value, subject, field) => {
  if (typeof value !== 'boolean') throw shapeRefusal(subject, field, 'must be true or false');
};

/** A u64. */
const count: Check = (value, subject, field) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw shapeRefusal(subject, field, 'must be a whole number, 0 or more');
  }
};

/** A `serde_json::Value`: any JSON at all, which validation reads later. */
const anyJson: Check = () => undefined;

function oneOf(words: readonly string[]): Check {
  return (value, subject, field) => {
    if (typeof value !== 'string' || !words.includes(value)) {
      throw shapeRefusal(subject, field, `must be one of ${words.join(', ')}`);
    }
  };
}

function listOf(item: Check): Check {
  return (value, subject, field) => {
    if (!Array.isArray(value)) throw shapeRefusal(subject, field, 'must be a list');
    value.forEach((entry, at) => item(entry, subject, `${field}[${at}]`));
  };
}

/** A struct: exactly `fields`, each checked under `<field>.<name>`. An absent
 * `Option` is written back as null, so the typed manifest never holds an
 * undefined where Rust holds a `None`. */
function struct(fields: Record<string, Field>): Check {
  return (value, subject, field) => {
    if (!isRecord(value)) throw shapeRefusal(subject, field, 'must be an object');
    const at = (key: string) => (field === '' ? key : `${field}.${key}`);
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(fields, key)) {
        throw shapeRefusal(subject, at(key), 'is not a field this format declares');
      }
    }
    for (const [key, spec] of Object.entries(fields)) {
      const optional = typeof spec !== 'function';
      if (value[key] === undefined) {
        if (!optional) throw shapeRefusal(subject, at(key), 'is missing');
        value[key] = null;
        continue;
      }
      if (optional && value[key] === null) continue;
      (optional ? spec.option : spec)(value[key], subject, at(key));
    }
  };
}

/** A list of structs, each answering as `<what> <its key>`, the subject
 * validation names it by, or by its index when it has no name to give. */
function named(what: string, key: string, fields: Record<string, Field>): Check {
  const check = struct(fields);
  return (value, subject, field) => {
    if (!Array.isArray(value)) throw shapeRefusal(subject, field, 'must be a list');
    value.forEach((entry, at) => {
      const name = isRecord(entry) ? entry[key] : undefined;
      check(entry, typeof name === 'string' ? `${what} ${name}` : `${field}[${at}]`, '');
    });
  };
}

/** A map of name to struct, each entry answering as `<what> <name>`. */
function mapOf(what: string, fields: Record<string, Field>): Check {
  const check = struct(fields);
  return (value, subject, field) => {
    if (!isRecord(value)) throw shapeRefusal(subject, field, 'must be an object');
    for (const [name, entry] of Object.entries(value)) check(entry, `${what} ${name}`, '');
  };
}

const TARGET = struct({ arg: { option: text }, kind: oneOf(TARGET_KINDS) });

const GENERATED = struct({
  prefix: text,
  title_prefix: text,
  toolset: text,
  kind: oneOf(KINDS),
  idempotent: flag,
  open_world: flag,
  door: text,
  axis: oneOf(AXES),
  exempt: { option: text },
  renderer: oneOf(RENDERERS),
  icon: text,
  always_load: flag,
  search_hint: text,
});

const MANIFEST_SHAPE = struct({
  format: count,
  artifact_version: count,
  rule_version: text,
  server: text,
  tokens: mapOf('token', { why: text }),
  doors: named('door', 'id', {
    id: text,
    writes: flag,
    kinds: listOf(oneOf(KINDS)),
    axes: listOf(oneOf(AXES)),
  }),
  toolsets: named('toolset', 'id', { id: text, label: text, hint: text }),
  prefix_exceptions: named('prefix exception', 'name', { name: text, why: text }),
  tools: named('tool', 'name', {
    name: text,
    surface: oneOf(SURFACES),
    title: text,
    summary: text,
    toolset: { option: text },
    kind: oneOf(KINDS),
    idempotent: flag,
    open_world: flag,
    door: text,
    axis: oneOf(AXES),
    target: { option: TARGET },
    exempt: { option: text },
    renderer: oneOf(RENDERERS),
    icon: text,
    always_load: flag,
    search_hint: text,
    description: text,
    input_schema: anyJson,
  }),
  // The subject validation names the block by.
  generated: (value) => GENERATED(value, 'generated', ''),
  cli_tools: named('cli tool', 'name', {
    name: text,
    writes: flag,
    denied_without_shell: flag,
    denied_when_read_scoped: flag,
    with_shell: flag,
    renderer: oneOf(RENDERERS),
    icon: text,
  }),
});

// --- What validation refuses, as tools.rs refuses it -----------------------

/** The facts a row and the generated block share, checked by one function. */
interface Facts {
  toolset: string | null;
  kind: Kind;
  idempotent: boolean;
  door: string;
  axis: Axis;
  target: Target | null;
  exempt: string | null;
  renderer: Renderer;
  icon: string;
  searchHint: string;
}

/** Characters as Rust counts them: Unicode scalar values. */
function chars(value: string): number {
  return [...value].length;
}

/** Is `value` within `limit` characters, and not blank? */
function fits(value: string, limit: number): boolean {
  return value.trim() !== '' && chars(value) <= limit;
}

/** `[a-z][a-z_]*` */
const SNAKE = /^[a-z][a-z_]*$/;
/** `[A-Z][A-Za-z]*` */
const PASCAL = /^[A-Z][A-Za-z]*$/;
/** `[a-z][a-z0-9-]*`: no underscore, so a server name cannot fake the `__`
 * the CLI joins it with. */
const SERVER_NAME = /^[a-z][a-z0-9-]*$/;
/** `[a-z0-9]+(-[a-z0-9]+)*`, the shape of a lucide icon name. */
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Every `{{name}}` in `value`, in order. */
function tokensIn(value: string): string[] {
  const found: string[] = [];
  let rest = value;
  for (;;) {
    const start = rest.indexOf('{{');
    if (start === -1) break;
    const after = rest.slice(start + 2);
    const end = after.indexOf('}}');
    if (end === -1) break;
    found.push(after.slice(0, end));
    rest = after.slice(end + 2);
  }
  return found;
}

/** Every string value inside `value`, depth first. */
function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => stringsIn(item, out));
  else if (isRecord(value)) Object.values(value).forEach((item) => stringsIn(item, out));
  return out;
}

/** A schema root's property names and its required list, or what is wrong
 * with it: the root must be an object type with properties, and `required`
 * must list only properties it declares. */
function schemaRoot(schema: unknown): { properties: Set<string>; required: Set<string> } | string {
  if (!isRecord(schema) || schema.type !== 'object') return 'must be an object type';
  if (!isRecord(schema.properties)) return 'must declare its properties';
  if (!Array.isArray(schema.required)) return 'must list what it requires';
  const required: string[] = [];
  for (const name of schema.required) {
    if (typeof name !== 'string') return 'requires a name that is not a string';
    required.push(name);
  }
  const properties = new Set(Object.keys(schema.properties));
  const missing = required.find((name) => !properties.has(name));
  if (missing !== undefined) return `requires ${missing}, which it does not declare`;
  return { properties, required: new Set(required) };
}

/** No door, toolset, tool or CLI tool is declared twice. */
function checkUnique(manifest: ToolsManifest): void {
  const groups: [string, string, string[]][] = [
    ['door', 'id', manifest.doors.map((door) => door.id)],
    ['toolset', 'id', manifest.toolsets.map((toolset) => toolset.id)],
    ['tool', 'name', manifest.tools.map((row) => row.name)],
    ['cli tool', 'name', manifest.cli_tools.map((tool) => tool.name)],
  ];
  for (const [what, field, names] of groups) {
    const seen = new Set<string>();
    for (const name of names) {
      if (seen.has(name)) throw refusal(`${what} ${name}`, field, 'is declared twice');
      seen.add(name);
    }
  }
}

/** The rules a row and the generated block both answer to. */
function checkFacts(manifest: ToolsManifest, subject: string, facts: Facts): void {
  if (facts.toolset !== null && !manifest.toolsets.some((t) => t.id === facts.toolset)) {
    throw refusal(subject, 'toolset', `names ${facts.toolset}, which no toolset declares`);
  }
  const door = manifest.doors.find((d) => d.id === facts.door);
  if (door === undefined) {
    throw refusal(subject, 'door', `names ${facts.door}, which no door declares`);
  }
  if (!door.kinds.includes(facts.kind)) {
    throw refusal(subject, 'kind', `${facts.kind} is not a kind door ${door.id} allows`);
  }
  if (facts.kind === 'read_only' && !facts.idempotent) {
    throw refusal(subject, 'idempotent', 'must be true for a read_only tool');
  }
  if (!door.axes.includes(facts.axis)) {
    throw refusal(subject, 'axis', `${facts.axis} is not an axis door ${door.id} allows`);
  }
  const target = facts.target;
  if (target !== null) {
    if (target.kind === 'bundle') {
      if (target.arg !== null) throw refusal(subject, 'target', 'bundle takes no argument');
    } else if (target.arg === null || target.arg === '') {
      throw refusal(subject, 'target', `${target.kind} needs an argument`);
    }
  }
  if (facts.axis === 'write' && target?.kind !== 'note' && target?.kind !== 'folder') {
    throw refusal(subject, 'target', 'must name a note or folder argument on the write axis');
  }
  if (facts.axis === 'read_write' && target?.kind !== 'note') {
    throw refusal(subject, 'target', 'must name a note argument on the read_write axis');
  }
  if (
    facts.axis === 'read' &&
    target !== null &&
    target.kind !== 'note' &&
    target.kind !== 'bundle'
  ) {
    throw refusal(
      subject,
      'target',
      `on the read axis must be a note or the bundle, not ${target.kind}`,
    );
  }
  if (facts.axis === 'none') {
    if (facts.exempt === null || facts.exempt.trim() === '') {
      throw refusal(subject, 'exempt', 'must say why no folder axis binds the tool');
    }
  } else if (facts.exempt !== null) {
    throw refusal(subject, 'exempt', `is set, but the ${facts.axis} axis binds the tool`);
  }
  if (facts.renderer === 'change') {
    if (!door.writes) {
      throw refusal(
        subject,
        'renderer',
        `change needs a door that writes, and ${door.id} does not`,
      );
    }
    if (target === null) throw refusal(subject, 'renderer', 'change needs a target');
  }
  if (!KEBAB.test(facts.icon)) {
    throw refusal(subject, 'icon', `must be a kebab-case name, not ${JSON.stringify(facts.icon)}`);
  }
  if (!fits(facts.searchHint, SEARCH_HINT_LIMIT)) {
    throw refusal(subject, 'search_hint', `must be 1 to ${SEARCH_HINT_LIMIT} characters`);
  }
}

function checkRow(manifest: ToolsManifest, row: ToolRow): void {
  const subject = `tool ${row.name}`;
  if (!SNAKE.test(row.name)) throw refusal(subject, 'name', 'must match [a-z][a-z_]*');
  const full = `mcp__${manifest.server}__${row.name}`;
  if (chars(full) > NAME_LIMIT) {
    throw refusal(subject, 'name', `is over ${NAME_LIMIT} characters as ${full}`);
  }
  if (!fits(row.title, TITLE_LIMIT)) {
    throw refusal(subject, 'title', `must be 1 to ${TITLE_LIMIT} characters`);
  }
  if (chars(row.summary) <= SUMMARY_FLOOR || row.summary === row.name) {
    throw refusal(
      subject,
      'summary',
      `must be longer than ${SUMMARY_FLOOR} characters and more than the name`,
    );
  }
  if (
    row.name.startsWith(manifest.generated.prefix) &&
    !manifest.prefix_exceptions.some((e) => e.name === row.name)
  ) {
    throw refusal(
      subject,
      'name',
      `carries the generated prefix ${manifest.generated.prefix}, and prefix_exceptions does not list it`,
    );
  }
  checkFacts(manifest, subject, {
    toolset: row.toolset,
    kind: row.kind,
    idempotent: row.idempotent,
    door: row.door,
    axis: row.axis,
    target: row.target,
    exempt: row.exempt,
    renderer: row.renderer,
    icon: row.icon,
    searchHint: row.search_hint,
  });
  const length = chars(row.description);
  if (length < DESCRIPTION_MIN || length > DESCRIPTION_MAX) {
    throw refusal(
      subject,
      'description',
      `must be ${DESCRIPTION_MIN} to ${DESCRIPTION_MAX} characters, not ${length}`,
    );
  }
  const root = schemaRoot(row.input_schema);
  if (typeof root === 'string') throw refusal(subject, 'input_schema', root);
  const arg = row.target?.arg ?? null;
  if (arg !== null && (!root.properties.has(arg) || !root.required.has(arg))) {
    throw refusal(subject, 'target', `names ${arg}, which input_schema must declare and require`);
  }
  const texts: [string, string[]][] = [
    ['description', [row.description]],
    ['input_schema', stringsIn(row.input_schema)],
  ];
  for (const [field, values] of texts) {
    for (const value of values) {
      const token = tokensIn(value).find((name) => !Object.hasOwn(manifest.tokens, name));
      if (token !== undefined) {
        throw refusal(subject, field, `names {{${token}}}, which tokens does not declare`);
      }
    }
  }
}

function checkGenerated(manifest: ToolsManifest): void {
  const generated = manifest.generated;
  if (!fits(generated.title_prefix, TITLE_LIMIT)) {
    throw refusal('generated', 'title_prefix', `must be 1 to ${TITLE_LIMIT} characters`);
  }
  checkFacts(manifest, 'generated', {
    toolset: generated.toolset,
    kind: generated.kind,
    idempotent: generated.idempotent,
    door: generated.door,
    axis: generated.axis,
    target: null,
    exempt: generated.exempt,
    renderer: generated.renderer,
    icon: generated.icon,
    searchHint: generated.search_hint,
  });
}

function checkCli(tool: CliTool): void {
  const subject = `cli tool ${tool.name}`;
  if (!PASCAL.test(tool.name)) throw refusal(subject, 'name', 'must match [A-Z][A-Za-z]*');
  if (tool.with_shell && !tool.denied_without_shell && !tool.denied_when_read_scoped) {
    throw refusal(
      subject,
      'with_shell',
      'grants a tool that neither denied_without_shell nor denied_when_read_scoped withdraws',
    );
  }
  if (tool.denied_without_shell && tool.denied_when_read_scoped) {
    throw refusal(
      subject,
      'denied_when_read_scoped',
      "is set on a tool denied_without_shell already, so a read-scoped run's one deny list would name it twice",
    );
  }
  if (tool.writes && !tool.denied_without_shell) {
    throw refusal(subject, 'denied_without_shell', 'must be set on a tool that writes');
  }
  if (tool.renderer === 'change' && !tool.writes) {
    throw refusal(subject, 'renderer', 'change needs a tool that writes');
  }
  if (!KEBAB.test(tool.icon)) {
    throw refusal(subject, 'icon', `must be a kebab-case name, not ${JSON.stringify(tool.icon)}`);
  }
}

function validate(manifest: ToolsManifest): void {
  const MANIFEST = 'manifest';
  if (manifest.format !== TOOLS_FORMAT) {
    throw refusal(MANIFEST, 'format', `must be ${TOOLS_FORMAT}, not ${manifest.format}`);
  }
  if (manifest.artifact_version === 0) {
    throw refusal(MANIFEST, 'artifact_version', 'must be positive');
  }
  if (manifest.rule_version.trim() === '') throw refusal(MANIFEST, 'rule_version', 'is empty');
  if (!SERVER_NAME.test(manifest.server)) {
    throw refusal(
      MANIFEST,
      'server',
      `must be lowercase letters, digits and hyphens, starting with a letter, not ${JSON.stringify(manifest.server)}`,
    );
  }
  checkUnique(manifest);
  for (const door of manifest.doors) {
    if (door.writes && door.kinds.includes('read_only')) {
      throw refusal(`door ${door.id}`, 'kinds', 'allows read_only on a door that writes');
    }
  }
  for (const row of manifest.tools) checkRow(manifest, row);
  checkGenerated(manifest);
  // Sorted, as the BTreeMap the Rust loader holds them in iterates.
  for (const token of Object.keys(manifest.tokens).sort()) {
    const marker = `{{${token}}}`;
    const used = manifest.tools.some((row) =>
      [row.description, ...stringsIn(row.input_schema)].some((value) => value.includes(marker)),
    );
    if (!used) throw refusal(`token ${token}`, 'tokens', 'declares it, and no tool uses it');
  }
  for (const exception of manifest.prefix_exceptions) {
    if (!manifest.tools.some((row) => row.name === exception.name)) {
      throw refusal(`prefix exception ${exception.name}`, 'name', 'names no tool');
    }
  }
  for (const toolset of manifest.toolsets) {
    const used =
      manifest.generated.toolset === toolset.id ||
      manifest.tools.some((row) => row.toolset === toolset.id);
    if (!used) throw refusal(`toolset ${toolset.id}`, 'id', 'is used by no tool');
  }
  for (const tool of manifest.cli_tools) checkCli(tool);
}

/**
 * Parse and fully validate a manifest: its shape, then every refusal
 * `tools.rs`'s `validate` makes. The value is checked in place and returned
 * typed, with any absent `Option` field written back as null.
 */
export function parseToolsManifest(value: unknown): ToolsManifest {
  if (!isRecord(value)) throw new Error(`${TOOLS_PATH}: must be a JSON object`);
  MANIFEST_SHAPE(value, 'manifest', '');
  const manifest = value as unknown as ToolsManifest;
  validate(manifest);
  return manifest;
}

/** The shipped manifest, validated once at module load. */
export const TOOLS: ToolsManifest = parseToolsManifest(rawTools);

// --- What a call is ---------------------------------------------------------

const SERVER_PREFIX = `mcp__${TOOLS.server}__`;
const ROWS = new Map(TOOLS.tools.map((row) => [row.name, row]));
const CLI_TOOLS = new Map(TOOLS.cli_tools.map((tool) => [tool.name, tool]));
const DOOR_WRITES = new Map(TOOLS.doors.map((door) => [door.id, door.writes]));
/** The ops a generated name may propose: the prefix alone is not enough, which
 * is what keeps `propose_organize` (a row) and `propose_revert_proposal` (an op
 * no agent is offered) out of the generated namespace. */
const AGENT_FACING = new Set(agentFacingOps(POLICY));

/** `name` without the `mcp__<server>__` prefix, or as given. */
export function bareToolName(name: string): string {
  return name.startsWith(SERVER_PREFIX) ? name.slice(SERVER_PREFIX.length) : name;
}

/** What the manifest says about one call. */
export interface ToolFacts {
  /** A hand-written row, the generated block, or the CLI's own list. */
  origin: 'row' | 'generated' | 'cli';
  /** Does a successful call change something on disk? */
  writes: boolean;
  renderer: Renderer;
  /** A lucide icon name. */
  icon: string;
  /** The argument the call is aimed by; generated and CLI tools have none. */
  target: Target | null;
}

/**
 * The manifest's facts for the tool `name` names, in its short or its
 * `mcp__<server>__` spelling, or null for a name it does not know (another
 * server's tool, an op no agent is offered). Rows first, then the generated
 * prefix and an agent-facing op, then the CLI's names, as `writes_disk` reads
 * them in tools.rs.
 */
export function toolFacts(name: string): ToolFacts | null {
  const bare = bareToolName(name);
  const row = ROWS.get(bare);
  if (row !== undefined) {
    return {
      origin: 'row',
      writes: DOOR_WRITES.get(row.door) === true,
      renderer: row.renderer,
      icon: row.icon,
      target: row.target,
    };
  }
  const generated = TOOLS.generated;
  if (bare.startsWith(generated.prefix) && AGENT_FACING.has(bare.slice(generated.prefix.length))) {
    return {
      origin: 'generated',
      writes: DOOR_WRITES.get(generated.door) === true,
      renderer: generated.renderer,
      icon: generated.icon,
      target: null,
    };
  }
  const cli = CLI_TOOLS.get(bare);
  if (cli !== undefined) {
    return {
      origin: 'cli',
      writes: cli.writes,
      renderer: cli.renderer,
      icon: cli.icon,
      target: null,
    };
  }
  return null;
}
