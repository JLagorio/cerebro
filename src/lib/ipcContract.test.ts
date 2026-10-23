/**
 * The webview and Rust agree on every command (M54.3).
 *
 * Nothing else holds the adapters' calls to `generate_handler!`, and Tauri
 * forgives exactly the mistakes that matter:
 *
 * - it derives each payload key from the Rust parameter with heck's
 *   lowerCamelCase (tauri-macros, `ArgumentCase::Camel`), so `from_seq` is
 *   sent as `fromSeq`, while the fields of a param struct keep serde's names;
 * - it ignores a key the command does not declare;
 * - it reads a missing `Option` key as `None` (`CommandItem::deserialize_option`).
 *
 * So a misspelt `read_scope` in run_agent's request runs unrestricted, and
 * e2e never notices: Playwright drives the mock and never crosses the real
 * IPC. This test reads files only. Its Rust half is a text scan of
 * src-tauri/src: `generate_handler!`, each command's parameters (minus the
 * ones Tauri injects), one level of serde struct fields, and every emit. Its
 * TypeScript half walks the four adapters with the compiler API. A shape
 * either half cannot read fails, with a message that names the fix.
 *
 * Not checked: payloads passed as variables (fleet_runs' filter,
 * job_ledger_import's entries, capture_concept_edit's request), return
 * shapes (agent_workspace's memory_files), ui-action action values, and
 * plugin calls (the dialog plugin's folder picker).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { DELEGATE_CEILINGS } from '@/lib/policy/toolApproval';

const REPO = join(__dirname, '../..');
const RS = 'src-tauri/src/';

/**
 * Commands nothing in the app calls, each with the reason it stays. The
 * owner's rule (M54): a command with no caller is flagged here, not deleted.
 */
const UNCALLED: Readonly<Record<string, string>> = {
  ambient_ingest_enabled:
    "M26.4i's per-vault spending switch for ambient ingest. No surface reads it, so ambient ingest stays off.",
  set_ambient_ingest:
    "M26.4i's per-vault spending switch for ambient ingest. No surface sets it, so ambient ingest stays off.",
  capture_concept_edit:
    "M23.5's capture boundary. The M23.7 valve captures in-app edits inside save_note and update_frontmatter.",
  ask_question: "M26.5e's attended ask over the ledger. No surface asks it yet.",
  trigger_record_pack: "M28.2b's owner evidence-pack recorder. No surface offers it yet.",
  git_workspace_info: 'An M9.4 git read no surface uses; the git surfaces ask is_git_repo.',
  get_last_commit_info:
    'An M9.4 git read no surface uses; history reads the file log and the pulse.',
  git_has_pending_changes:
    'An M9.4 git read no surface uses; the changes view reads modified files.',
  git_file_url: 'An M9.4 git read no surface uses; no page links a file to its remote yet.',
  git_clone: "M9.4's clone door. No surface clones a vault yet.",
  root_git_workspace_info:
    "An M32.8 root-git read, re-landed by M53.2. RootTree's badge reads only remote status and modified files.",
  root_git_pulse:
    "An M32.8 root-git read, re-landed by M53.2. RootTree's badge reads only remote status and modified files.",
  root_git_file_url:
    "An M32.8 root-git read, re-landed by M53.2. RootTree's badge reads only remote status and modified files.",
  stop_all_agents:
    'The manual stop-everything door. Quit and a vault switch stop runs in Rust (M53.10); no surface offers it.',
};

/** What Rust emits, and exactly what the adapters listen to. */
const EVENTS: readonly string[] = [
  'cerebro://agent',
  'cerebro://deep-link',
  'cerebro://quit-requested',
  'cerebro://ui-action',
  'comments-changed',
  'vault-changed',
];

// --- Spelling ---------------------------------------------------------------

/** heck's lowerCamelCase of a snake_case name: the key Tauri reads. */
function camel(name: string): string {
  return name
    .split('_')
    .filter((word) => word !== '')
    .map((word, i) => (i === 0 ? word : word[0].toUpperCase() + word.slice(1)))
    .join('');
}

function snake(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** Names Rust's spelling when the key is the same word in the other case. */
function hint(key: string, known: readonly string[]): string {
  const near = [camel(key), snake(key)].find((word) => word !== key && known.includes(word));
  return near === undefined ? '' : ` (Rust spells it "${near}")`;
}

// --- The Rust half: a text scan ---------------------------------------------

interface RustParam {
  name: string;
  key: string;
  type: string;
  optional: boolean;
}

interface RustCommand {
  name: string;
  /** Relative to src-tauri/src. */
  file: string;
  /** The parameters the webview sends: the injected ones are left out. */
  params: RustParam[];
}

interface Field {
  /** The key serde reads, then any aliases. */
  keys: string[];
  required: boolean;
}

interface Shape {
  label: string;
  fields: Field[];
  /** Keys of `skip`/`skip_deserializing` fields: Rust never reads them. */
  skipped: string[];
}

interface RustSide {
  commands: Map<string, RustCommand>;
  events: Set<string>;
  problems: string[];
  /** A param struct one level deep; a string says why it cannot be read,
   * and null is a free-form map, whose keys are the caller's business. */
  shape(type: string, from: string): Shape | string | null;
}

const INJECTED = new Set([
  'AppHandle',
  'State',
  'Window',
  'Webview',
  'WebviewWindow',
  'Request',
  'CommandScope',
  'GlobalScope',
]);
const FREE_FORM =
  /^(?:serde_json::)?(?:Value|Map)\b|^(?:std::collections::)?(?:HashMap|BTreeMap)\b/;
const SNAKE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const ENTRY = /^[a-z][a-z0-9_]*(?:::[a-z][a-z0-9_]*)*$/;
const FN = /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/;
const TYPE_DECL = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|type|union|trait)\s+(\w+)/;
const CONST_STR =
  /^\s*(?:pub(?:\([^)]*\))?\s+)?const\s+([A-Z][A-Z0-9_]*)\s*:\s*&(?:'static\s+)?str\s*=\s*"((?:[^"\\]|\\.)*)"\s*;/;
const EMIT = /\.(emit(?:_to|_filter|_str(?:_to|_filter)?)?)\s*\(/g;
const ITEM = /^([a-z_]+)(?:\s*=\s*"((?:[^"\\]|\\.)*)")?$/;
/** Field attributes that change no key and no requiredness. */
const PASSIVE = new Set([
  'skip_serializing',
  'skip_serializing_if',
  'with',
  'deserialize_with',
  'serialize_with',
]);
const OPEN = '([{<';
const CLOSE = ')]}>';

function endOfString(text: string, at: number): number {
  for (let i = at + 1; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === '"') return i;
  }
  return text.length;
}

/** A line with its trailing `//` comment cut; string literals stay whole. */
function codeOf(line: string): string {
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') i = endOfString(line, i);
    else if (c === "'" && line[i + 2] === "'") i += 2;
    else if (c === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

/** Whether `text[i]` is a bracket, and which way: `->` and `=>` are not. */
function bracket(text: string, i: number): 1 | -1 | 0 {
  const c = text[i];
  if (OPEN.includes(c)) return 1;
  if (!CLOSE.includes(c)) return 0;
  return c === '>' && (text[i - 1] === '-' || text[i - 1] === '=') ? 0 : -1;
}

/** The index that closes the bracket at `at`, or -1. */
function closeOf(text: string, at: number): number {
  let depth = 0;
  for (let i = at; i < text.length; i += 1) {
    if (text[i] === '"') {
      i = endOfString(text, i);
      continue;
    }
    depth += bracket(text, i);
    if (depth === 0) return i;
  }
  return -1;
}

/** `text` cut at its depth-0 commas, each piece trimmed, empty pieces dropped. */
function splitTop(text: string): string[] {
  const pieces: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '"') {
      i = endOfString(text, i);
      continue;
    }
    depth += bracket(text, i);
    if (text[i] === ',' && depth === 0) {
      pieces.push(text.slice(start, i));
      start = i + 1;
    }
  }
  pieces.push(text.slice(start));
  return pieces.map((piece) => piece.trim()).filter((piece) => piece !== '');
}

function skipSpace(text: string, at: number): number {
  let i = at;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  return i;
}

function isOption(type: string): boolean {
  return /^(?:(?:std|core)::option::)?Option\s*</.test(type.trim());
}

/** The items of every `#[serde(...)]` in `text`. */
function serdeItems(text: string): string[] {
  const items: string[] = [];
  for (let at = text.indexOf('#[serde('); at !== -1; at = text.indexOf('#[serde(', at + 1)) {
    const open = at + '#[serde'.length;
    const close = closeOf(text, open);
    if (close === -1) break;
    items.push(...splitTop(text.slice(open + 1, close)));
  }
  return items;
}

/** The entries of the one `generate_handler![...]` in lib.rs. */
function handlerEntries(lib: string, problems: string[]): string[] {
  const MARK = 'generate_handler![';
  const found = lib.split(MARK).length - 1;
  const open = lib.indexOf(MARK) + MARK.length - 1;
  const close = found === 1 ? closeOf(lib, open) : -1;
  if (close === -1) {
    problems.push(`${RS}lib.rs: generate_handler![ must appear once, closed; found ${found}`);
    return [];
  }
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const entry of splitTop(lib.slice(open + 1, close))) {
    const leaf = entry.split('::').at(-1) ?? '';
    if (!ENTRY.test(entry)) {
      problems.push(`${RS}lib.rs: generate_handler! entry "${entry}" is not a path to a fn`);
    } else if (seen.has(leaf)) {
      problems.push(`${RS}lib.rs: generate_handler! registers ${leaf} twice`);
    } else {
      seen.add(leaf);
      entries.push(entry);
    }
  }
  return entries;
}

interface RawCommand {
  name: string;
  line: number;
  params: { name: string; type: string }[];
}

/** Every `#[tauri::command]` fn in one file, read from its attribute down. */
function commandsIn(file: string, lines: readonly string[], problems: string[]): RawCommand[] {
  const found: RawCommand[] = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    const at = `${RS}${file}:${i + 1}`;
    if (/^#\[\s*command\b/.test(t)) {
      problems.push(`${at}: a bare #[command] is refused: write #[tauri::command]`);
    } else if (!t.startsWith('#[tauri::command')) {
      return;
    } else if (t !== '#[tauri::command]' && t !== '#[tauri::command(async)]') {
      problems.push(
        `${at}: ${t} is refused: Tauri must take the command's name and keys from the fn as written`,
      );
    }
    const rest = lines.slice(i + 1, i + 81).join('\n');
    let k = skipSpace(rest, 0);
    while (rest.startsWith('#[', k) && closeOf(rest, k + 1) !== -1) {
      k = skipSpace(rest, closeOf(rest, k + 1) + 1);
    }
    const fn = FN.exec(rest.slice(k));
    if (fn === null) {
      problems.push(`${at}: #[tauri::command] is not followed by a fn`);
      return;
    }
    const name = fn[1];
    let p = skipSpace(rest, k + fn[0].length);
    if (rest[p] === '<') p = skipSpace(rest, closeOf(rest, p) + 1);
    const close = rest[p] === '(' ? closeOf(rest, p) : -1;
    if (close === -1) {
      problems.push(`${at}: the parameters of ${name} do not parse`);
      return;
    }
    const params: RawCommand['params'] = [];
    for (const piece of splitTop(rest.slice(p + 1, close))) {
      const param = /^(?:mut\s+)?(\w+)\s*:\s*([\s\S]+)$/.exec(piece);
      if (param === null) problems.push(`${at}: ${name}'s parameter "${piece}" does not parse`);
      else params.push({ name: param[1], type: param[2].replace(/\s+/g, ' ') });
    }
    found.push({ name, line: i + 1, params });
  });
  return found;
}

function eventOf(after: string, consts: ReadonlyMap<string, ReadonlySet<string>>): string | null {
  const literal = /^"((?:[^"\\]|\\.)*)"\s*,/.exec(after);
  if (literal !== null) return literal[1];
  const named = /^(?:\w+::)*([A-Z][A-Z0-9_]*)\s*,/.exec(after);
  const values = named === null ? undefined : consts.get(named[1]);
  return values?.size === 1 ? [...values][0] : null;
}

function rustSide(files: ReadonlyMap<string, string>): RustSide {
  const problems: string[] = [];
  const raw = new Map<string, string[]>();
  const code = new Map<string, string[]>();
  for (const [file, text] of files) {
    const lines = text.split(/\r?\n/);
    raw.set(file, lines);
    code.set(file, lines.map(codeOf));
  }

  const typeNames = new Set<string>();
  const consts = new Map<string, Set<string>>();
  for (const lines of code.values()) {
    for (const line of lines) {
      const type = TYPE_DECL.exec(line);
      if (type !== null) typeNames.add(type[1]);
      const named = CONST_STR.exec(line);
      if (named !== null) consts.set(named[1], (consts.get(named[1]) ?? new Set()).add(named[2]));
    }
  }

  const found = new Map<string, RawCommand[]>();
  for (const [file, lines] of code) found.set(file, commandsIn(file, lines, problems));

  const commands = new Map<string, RustCommand>();
  const registered = new Set<string>();
  const entries = handlerEntries((code.get('lib.rs') ?? []).join('\n'), problems);
  for (const entry of entries) {
    const segments = entry.split('::');
    const leaf = segments[segments.length - 1];
    const dir = segments.slice(0, -1).join('/');
    const homes = dir === '' ? ['lib.rs'] : [`${dir}.rs`, `${dir}/mod.rs`];
    const file = homes.find((home) => files.has(home));
    const fns = file === undefined ? [] : (found.get(file) ?? []).filter((c) => c.name === leaf);
    if (file !== undefined) registered.add(`${file}#${leaf}`);
    if (file === undefined || fns.length !== 1) {
      problems.push(
        fns.length === 0
          ? `${RS}lib.rs: generate_handler! registers ${entry}, but ${homes.map((h) => RS + h).join(' or ')} holds no #[tauri::command] fn ${leaf}`
          : `${RS}lib.rs: generate_handler! registers ${entry}, and ${RS}${file} holds ${fns.length} #[tauri::command] fns named ${leaf}`,
      );
      continue;
    }
    const params: RustParam[] = [];
    for (const { name, type } of fns[0].params) {
      const head = type
        .replace(/^&\s*(?:'\w+\s+)?(?:mut\s+)?/, '')
        .split('<')[0]
        .trim();
      const path = head.split('::');
      const last = path[path.length - 1];
      if (INJECTED.has(last)) {
        if (path[0] === 'tauri' || (path.length === 1 && !typeNames.has(last))) continue;
        problems.push(
          `${RS}${file}:${fns[0].line}: ${leaf}'s ${name} is typed ${head}, which is not plainly Tauri's: write tauri::${last}`,
        );
        continue;
      }
      if (!SNAKE.test(name)) {
        problems.push(
          `${RS}${file}:${fns[0].line}: ${leaf}'s parameter ${name} is not snake_case, so its key is a guess`,
        );
      }
      params.push({ name, key: camel(name), type, optional: isOption(type) });
    }
    commands.set(leaf, { name: leaf, file, params });
  }
  for (const [file, list] of found) {
    for (const command of list) {
      if (!registered.has(`${file}#${command.name}`)) {
        problems.push(
          `${RS}${file}:${command.line}: #[tauri::command] fn ${command.name} is not in generate_handler!`,
        );
      }
    }
  }

  const events = new Set<string>();
  for (const [file, lines] of code) {
    lines.forEach((line, i) => {
      for (const emit of line.matchAll(EMIT)) {
        const at = `${RS}${file}:${i + 1}`;
        if (emit[1] !== 'emit') {
          problems.push(
            `${at}: .${emit[1]}( is refused: emit to every listener with .emit(NAME, payload)`,
          );
          continue;
        }
        const after = [line.slice((emit.index ?? 0) + emit[0].length), ...lines.slice(i + 1, i + 3)]
          .join('\n')
          .trimStart();
        const event = eventOf(after, consts);
        if (event === null) {
          problems.push(`${at}: .emit's event is neither a string literal nor one const &str`);
        } else {
          events.add(event);
        }
      }
    });
  }

  const structsNamed = (file: string, name: string): { file: string; line: number }[] => {
    const decl = new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?struct\\s+${name}\\b`);
    return (code.get(file) ?? []).flatMap((line, i) =>
      decl.test(line) ? [{ file, line: i }] : [],
    );
  };

  const readStruct = (file: string, line: number, label: string): Shape | string => {
    const lines = code.get(file) ?? [];
    const text = raw.get(file) ?? [];
    let top = line;
    while (top > 0 && text[top - 1].trim() !== '' && !/[;{}]$/.test(lines[top - 1].trim())) {
      top -= 1;
    }
    let renameAll: string | undefined;
    let structDefault = false;
    for (const item of serdeItems(lines.slice(top, line).join('\n'))) {
      const [, name, value] = ITEM.exec(item) ?? [];
      if (name === 'rename_all' && (value === 'camelCase' || value === 'snake_case')) {
        renameAll = value;
      } else if (name === 'default') {
        structDefault = true;
      } else if (name !== 'deny_unknown_fields') {
        return `${label}'s #[serde(${item})] is refused: the scan reads rename_all as camelCase or snake_case, default and deny_unknown_fields`;
      }
    }
    const body = lines.slice(line, line + 400).join('\n');
    const open = body.search(/[{(;]/);
    const close = body[open] === '{' ? closeOf(body, open) : -1;
    if (close === -1) return `${label} is not a struct with named fields`;
    const fields: Field[] = [];
    const skipped: string[] = [];
    for (const piece of splitTop(body.slice(open + 1, close))) {
      let rest = piece;
      const items: string[] = [];
      while (rest.startsWith('#[') && closeOf(rest, 1) !== -1) {
        const end = closeOf(rest, 1);
        items.push(...serdeItems(rest.slice(0, end + 1)));
        rest = rest.slice(end + 1).trim();
      }
      const field = /^(?:pub(?:\([^)]*\))?\s+)?([a-z_][a-z0-9_]*)\s*:\s*([\s\S]+)$/.exec(rest);
      if (field === null) return `${label}'s field "${rest}" does not parse`;
      let rename: string | undefined;
      const aliases: string[] = [];
      let fieldDefault = false;
      let skip = false;
      for (const item of items) {
        const [, name, value] = ITEM.exec(item) ?? [];
        if (name === 'flatten') {
          return `${label}'s #[serde(flatten)] on ${field[1]} is refused: the scan cannot see the keys it pulls in`;
        }
        if (name === 'rename' && value !== undefined) rename = value;
        else if (name === 'alias' && value !== undefined) aliases.push(value);
        else if (name === 'default') fieldDefault = true;
        else if (name === 'skip' || name === 'skip_deserializing') skip = true;
        else if (name === undefined || !PASSIVE.has(name)) {
          return `${label}'s #[serde(${item})] on ${field[1]} is refused: the scan reads rename, alias, default, skip and skip_deserializing`;
        }
      }
      const key = rename ?? (renameAll === 'camelCase' ? camel(field[1]) : field[1]);
      if (skip) skipped.push(key);
      else {
        fields.push({
          keys: [key, ...aliases],
          required: !isOption(field[2]) && !fieldDefault && !structDefault,
        });
      }
    }
    return { label, fields, skipped };
  };

  const shape = (type: string, from: string): Shape | string | null => {
    let inner = type.trim();
    while (isOption(inner)) {
      inner = inner.slice(inner.indexOf('<') + 1, inner.lastIndexOf('>')).trim();
    }
    if (FREE_FORM.test(inner)) return null;
    if (!/^(?:\w+::)*[A-Z]\w*$/.test(inner)) return `${type} is not a struct the scan can open`;
    const segments = inner.replace(/^crate::/, '').split('::');
    const name = segments[segments.length - 1];
    const dir = segments.slice(0, -1).join('/');
    const homes = dir === '' ? [from] : [`${dir}.rs`, `${dir}/mod.rs`];
    let structs = homes.flatMap((home) => structsNamed(home, name));
    if (structs.length === 0) {
      structs = [...code.keys()].flatMap((file) => structsNamed(file, name));
    }
    if (structs.length !== 1) {
      return structs.length === 0
        ? `${inner} names no struct in the crate`
        : `${structs.length} structs are named ${name}: name ${inner} by its module path`;
    }
    return readStruct(structs[0].file, structs[0].line, inner);
  };

  return { commands, events, problems, shape };
}

// --- The TypeScript half: the compiler API ----------------------------------

interface Site {
  file: string;
  line: number;
  cmd: string;
  /** False when the payload has a shape the scan cannot read (reported). */
  read: boolean;
  keys: string[];
  /** One level of object-literal keys under a top-level key. */
  nested: Map<string, string[]>;
  /** The exported function that holds the call; null is reported. */
  owner: string | null;
  guarded: boolean;
}

interface Heard {
  file: string;
  line: number;
  event: string;
  owner: string | null;
  guarded: boolean;
}

interface TsSide {
  adapters: string[];
  sites: Site[];
  heard: Heard[];
  problems: string[];
  /** `file#export` for every adapter export an app file imports. */
  called: Set<string>;
}

interface Forwarder {
  cmd: number;
  args: number;
  /** null for the raw `invoke` binding itself. */
  node: ts.FunctionDeclaration | null;
}

const CORE = '@tauri-apps/api/core';
const EVENT = '@tauri-apps/api/event';
const BINDABLE: Readonly<Record<string, readonly string[]>> = {
  [CORE]: ['invoke'],
  [EVENT]: ['listen', 'once'],
};

function isTestFile(file: string): boolean {
  return /\.(?:test|spec)\.tsx?$/.test(file) || file.startsWith('src/test/');
}

function parse(file: string, text: string): ts.SourceFile {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

function isExported(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function typeOnly(clause: ts.ImportClause): boolean {
  return clause.phaseModifier === ts.SyntaxKind.TypeKeyword;
}

/** A tauri module named by a string literal, or null. */
function tauriModule(node: ts.Node | undefined): string | null {
  if (node === undefined || !ts.isStringLiteralLike(node)) return null;
  return node.text === CORE || node.text === EVENT ? node.text : null;
}

/** A plain key, or what is wrong with it. */
function keyOf(prop: ts.ObjectLiteralElementLike): string | { problem: string } {
  if (ts.isShorthandPropertyAssignment(prop)) return prop.name.text;
  if (
    ts.isPropertyAssignment(prop) &&
    (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
  ) {
    return prop.name.text;
  }
  if (ts.isSpreadAssignment(prop)) return { problem: 'spreads an object: name every key' };
  if (ts.isPropertyAssignment(prop) && ts.isComputedPropertyName(prop.name)) {
    return { problem: 'has a computed key: name every key' };
  }
  return { problem: 'holds something other than plain keys: name every key' };
}

/** Whether `id` is used as a value rather than called, bound or named. */
function usedAsValue(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (ts.isCallExpression(parent) && parent.expression === id) return false;
  if (ts.isImportSpecifier(parent) || ts.isBindingElement(parent)) return false;
  // `export { invoke } from '…'` names the module's export, not this binding.
  if (ts.isExportSpecifier(parent) && parent.parent.parent.moduleSpecifier !== undefined) {
    return false;
  }
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false;
  return !(ts.isPropertyAssignment(parent) && parent.name === id);
}

function scanAdapter(file: string, text: string, out: TsSide): void {
  const sf = parse(file, text);
  const at = (node: ts.Node): string =>
    `${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
  const invokes = new Set<string>();
  const listens = new Set<string>();

  const bind = (node: ts.Node, spec: string, imported: string, local: string): void => {
    if (!BINDABLE[spec].includes(imported)) {
      out.problems.push(
        `${at(node)}: ${imported} from ${spec} is a door this test cannot check: reach Rust through invoke or listen`,
      );
      return;
    }
    if (imported !== local) {
      out.problems.push(
        `${at(node)}: ${imported} from ${spec} is bound as ${local}: bind it by its own name`,
      );
    }
    (spec === CORE ? invokes : listens).add(local);
  };
  const whole = (node: ts.Node, spec: string): void => {
    out.problems.push(
      `${at(node)}: ${spec} is taken whole: destructure the function by its own name`,
    );
  };

  walk(sf, (node) => {
    if (ts.isImportDeclaration(node)) {
      const spec = tauriModule(node.moduleSpecifier);
      const clause = node.importClause;
      if (spec === null || clause === undefined || typeOnly(clause)) return;
      const named = clause.namedBindings;
      if (clause.name !== undefined || (named !== undefined && ts.isNamespaceImport(named))) {
        whole(node, spec);
      }
      if (named !== undefined && ts.isNamedImports(named)) {
        for (const el of named.elements) {
          if (!el.isTypeOnly) bind(el, spec, (el.propertyName ?? el.name).text, el.name.text);
        }
      }
    } else if (ts.isExportDeclaration(node) && tauriModule(node.moduleSpecifier) !== null) {
      out.problems.push(
        `${at(node)}: re-exports a Tauri module: only the adapters may reach Tauri`,
      );
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const spec = tauriModule(node.arguments[0]);
      if (spec === null) return;
      const holder = ts.isAwaitExpression(node.parent) ? node.parent.parent : undefined;
      if (
        holder === undefined ||
        !ts.isVariableDeclaration(holder) ||
        !ts.isObjectBindingPattern(holder.name)
      ) {
        whole(node, spec);
        return;
      }
      for (const el of holder.name.elements) {
        const imported = el.propertyName ?? el.name;
        if (
          el.dotDotDotToken !== undefined ||
          !ts.isIdentifier(el.name) ||
          !ts.isIdentifier(imported)
        ) {
          whole(el, spec);
        } else {
          bind(el, spec, imported.text, el.name.text);
        }
      }
    }
  });

  const constants = new Map<string, string>();
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const decl of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(decl.name) &&
        decl.initializer &&
        ts.isStringLiteralLike(decl.initializer)
      ) {
        constants.set(decl.name.text, decl.initializer.text);
      }
    }
  }

  // Forwarders: invokeTauri hands its own (cmd, args) to invoke, and any
  // function that hands its own params to a forwarder's two slots is one too.
  const decls: [string, ts.FunctionDeclaration][] = [];
  walk(sf, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined) {
      decls.push([node.name.text, node]);
    }
  });
  const forwarders = new Map<string, Forwarder>();
  for (const name of invokes) forwarders.set(name, { cmd: 0, args: 1, node: null });
  const slotsOf = (
    call: ts.CallExpression,
    callee: Forwarder,
    fn: ts.FunctionDeclaration,
  ): { cmd: number; args: number } | null => {
    const names = fn.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : ''));
    const cmd = call.arguments.at(callee.cmd);
    const args = call.arguments.at(callee.args);
    if (
      cmd === undefined ||
      args === undefined ||
      !ts.isIdentifier(cmd) ||
      !ts.isIdentifier(args)
    ) {
      return null;
    }
    const slots = { cmd: names.indexOf(cmd.text), args: names.indexOf(args.text) };
    return slots.cmd === -1 || slots.args === -1 ? null : slots;
  };
  const calleeOf = (call: ts.CallExpression): Forwarder | undefined =>
    ts.isIdentifier(call.expression) ? forwarders.get(call.expression.text) : undefined;
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, fn] of decls) {
      if (forwarders.has(name)) continue;
      walk(fn, (node) => {
        if (forwarders.has(name) || !ts.isCallExpression(node)) return;
        const callee = calleeOf(node);
        if (callee === undefined || (callee.node === null && name !== 'invokeTauri')) return;
        const slots = slotsOf(node, callee, fn);
        if (slots === null) return;
        forwarders.set(name, { ...slots, node: fn });
        grew = true;
        if (isExported(fn)) {
          out.problems.push(
            `${at(fn)}: ${name} forwards to Rust and is exported: keep it inside ${file}`,
          );
        }
      });
    }
  }

  const inTauriCache = new Map<ts.Node, boolean>();
  const callsInTauri = (fn: ts.Node): boolean => {
    const cached = inTauriCache.get(fn);
    if (cached !== undefined) return cached;
    let found = false;
    walk(fn, (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        found ||= node.expression.text === 'inTauri';
      }
    });
    inTauriCache.set(fn, found);
    return found;
  };
  const guarded = (node: ts.Node, via: ts.FunctionDeclaration | null): boolean => {
    for (let up: ts.Node | undefined = node.parent; up !== undefined; up = up.parent) {
      if (isFunctionLike(up) && callsInTauri(up)) return true;
    }
    return via !== null && callsInTauri(via);
  };
  const nearestFunction = (node: ts.Node): ts.Node | undefined => {
    for (let up: ts.Node | undefined = node.parent; up !== undefined; up = up.parent) {
      if (isFunctionLike(up)) return up;
    }
    return undefined;
  };
  const ownerOf = (node: ts.Node): string | null => {
    let top = node;
    while (top.parent !== undefined && !ts.isSourceFile(top.parent)) top = top.parent;
    if (ts.isFunctionDeclaration(top) && top.name !== undefined && isExported(top)) {
      return top.name.text;
    }
    if (ts.isVariableStatement(top) && isExported(top)) {
      for (const decl of top.declarationList.declarations) {
        const holds = decl.pos <= node.pos && node.end <= decl.end;
        if (
          holds &&
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          isFunctionLike(decl.initializer)
        ) {
          return decl.name.text;
        }
      }
    }
    return null;
  };

  walk(sf, (node) => {
    if (
      ts.isIdentifier(node) &&
      (invokes.has(node.text) || listens.has(node.text)) &&
      usedAsValue(node)
    ) {
      out.problems.push(
        `${at(node)}: ${node.text} is passed around as a value: call it where it is bound`,
      );
      return;
    }
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
    const name = node.expression.text;
    const enclosing = nearestFunction(node);

    if (invokes.has(name)) {
      const home =
        enclosing !== undefined &&
        ts.isFunctionDeclaration(enclosing) &&
        enclosing.name?.text === 'invokeTauri'
          ? enclosing
          : undefined;
      if (home === undefined) {
        out.problems.push(`${at(node)}: invoke is called outside invokeTauri: call invokeTauri`);
      } else if (slotsOf(node, { cmd: 0, args: 1, node: null }, home) === null) {
        out.problems.push(`${at(node)}: invokeTauri must hand invoke its own cmd and args`);
      }
      return;
    }

    if (listens.has(name)) {
      const arg = node.arguments.at(0);
      const event =
        arg === undefined
          ? undefined
          : ts.isStringLiteralLike(arg)
            ? arg.text
            : ts.isIdentifier(arg)
              ? constants.get(arg.text)
              : undefined;
      if (event === undefined) {
        out.problems.push(
          `${at(node)}: ${name}'s event must be a string literal or a const in this file`,
        );
        return;
      }
      const owner = ownerOf(node);
      if (owner === null) {
        out.problems.push(`${at(node)}: "${event}" is heard outside an exported function`);
      }
      out.heard.push({
        file,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        event,
        owner,
        guarded: guarded(node, null),
      });
      return;
    }

    const callee = forwarders.get(name);
    if (callee === undefined || callee.node === null) return;
    if (
      enclosing !== undefined &&
      ts.isFunctionDeclaration(enclosing) &&
      enclosing.name !== undefined
    ) {
      const own = forwarders.get(enclosing.name.text);
      const slots = own?.node === enclosing ? slotsOf(node, callee, enclosing) : null;
      if (own !== undefined && slots?.cmd === own.cmd && slots.args === own.args) return;
    }

    const cmdArg = node.arguments.at(callee.cmd);
    if (cmdArg === undefined || !ts.isStringLiteralLike(cmdArg)) {
      out.problems.push(`${at(node)}: the command name must be a string literal`);
      return;
    }
    const cmd = cmdArg.text;
    const payload = node.arguments.at(callee.args);
    const keys: string[] = [];
    const nested = new Map<string, string[]>();
    let read = true;
    if (payload !== undefined && !ts.isObjectLiteralExpression(payload)) {
      out.problems.push(
        `${at(node)}: ${cmd}'s payload must be an object literal, so its keys can be read`,
      );
      read = false;
    } else if (payload !== undefined) {
      for (const prop of payload.properties) {
        const key = keyOf(prop);
        if (typeof key !== 'string') {
          out.problems.push(`${at(prop)}: ${cmd}'s payload ${key.problem}`);
          read = false;
          continue;
        }
        keys.push(key);
        if (!ts.isPropertyAssignment(prop) || !ts.isObjectLiteralExpression(prop.initializer)) {
          continue;
        }
        const inner: string[] = [];
        for (const field of prop.initializer.properties) {
          const fieldKey = keyOf(field);
          if (typeof fieldKey === 'string') inner.push(fieldKey);
          else {
            out.problems.push(`${at(field)}: ${cmd}'s ${key} ${fieldKey.problem}`);
            read = false;
          }
        }
        nested.set(key, inner);
      }
    }
    const owner = ownerOf(node);
    if (owner === null) {
      out.problems.push(`${at(node)}: ${cmd} is invoked outside an exported function`);
    }
    out.sites.push({
      file,
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      cmd,
      read,
      keys,
      nested,
      owner,
      guarded: guarded(node, callee.node),
    });
  });
}

/** A `@/` or relative specifier resolved to a file in `known`, else null. */
function resolve(from: string, spec: string, known: ReadonlySet<string>): string | null {
  const base = spec.startsWith('@/')
    ? `src/${spec.slice(2)}`
    : spec.startsWith('.')
      ? posix.join(posix.dirname(from), spec)
      : null;
  if (base === null) return null;
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
  return candidates.find((candidate) => known.has(candidate)) ?? null;
}

/**
 * Production callers: an app file (not a test, not the adapter itself) that
 * imports the export by name, or reads `ns.<name>` off an `import * as ns`
 * or an `await import()` of the adapter. The mocks define functions with the
 * same names, so a bare identifier never counts.
 */
function findCallers(
  files: ReadonlyMap<string, string>,
  app: readonly string[],
  out: TsSide,
): void {
  const adapters = new Set(out.adapters);
  const stems = out.adapters.map((file) => posix.basename(file).replace(/\.tsx?$/, ''));
  const known = new Set(files.keys());
  for (const file of app) {
    const text = files.get(file) ?? '';
    if (!stems.some((stem) => text.includes(stem))) continue;
    const sf = parse(file, text);
    const target = (spec: ts.Node | undefined): string | null => {
      if (spec === undefined || !ts.isStringLiteralLike(spec)) return null;
      const hit = resolve(file, spec.text, known);
      return hit !== null && hit !== file && adapters.has(hit) ? hit : null;
    };
    const spaces = new Map<string, string>();
    walk(sf, (node) => {
      if (ts.isImportDeclaration(node)) {
        const hit = target(node.moduleSpecifier);
        const clause = node.importClause;
        if (hit === null || clause === undefined || typeOnly(clause)) return;
        const named = clause.namedBindings;
        if (named !== undefined && ts.isNamespaceImport(named)) spaces.set(named.name.text, hit);
        if (named !== undefined && ts.isNamedImports(named)) {
          for (const el of named.elements) {
            if (!el.isTypeOnly) out.called.add(`${hit}#${(el.propertyName ?? el.name).text}`);
          }
        }
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      ) {
        const hit = target(node.arguments[0]);
        const holder = ts.isAwaitExpression(node.parent) ? node.parent.parent : undefined;
        if (hit === null || holder === undefined || !ts.isVariableDeclaration(holder)) return;
        if (ts.isIdentifier(holder.name)) spaces.set(holder.name.text, hit);
        else if (ts.isObjectBindingPattern(holder.name)) {
          for (const el of holder.name.elements) {
            const prop = el.propertyName ?? el.name;
            if (ts.isIdentifier(prop)) out.called.add(`${hit}#${prop.text}`);
          }
        }
      }
    });
    if (spaces.size === 0) continue;
    walk(sf, (node) => {
      if (!ts.isPropertyAccessExpression(node) || !ts.isIdentifier(node.expression)) return;
      const hit = spaces.get(node.expression.text);
      if (hit !== undefined) out.called.add(`${hit}#${node.name.text}`);
    });
  }
}

function tsSide(files: ReadonlyMap<string, string>): TsSide {
  const out: TsSide = { adapters: [], sites: [], heard: [], problems: [], called: new Set() };
  const app = [...files.keys()].filter((file) => file.startsWith('src/') && !isTestFile(file));
  out.adapters = app
    .filter((file) => {
      const text = files.get(file) ?? '';
      return text.includes(CORE) || text.includes(EVENT);
    })
    .sort();
  for (const file of out.adapters) scanAdapter(file, files.get(file) ?? '', out);
  findCallers(files, app, out);
  return out;
}

// --- The audit --------------------------------------------------------------

/** Commands some site reaches from an export an app file imports. */
function pathed(side: TsSide): Set<string> {
  return new Set(
    side.sites
      .filter((site) => site.owner !== null && side.called.has(`${site.file}#${site.owner}`))
      .map((site) => site.cmd),
  );
}

function audit(
  rust: RustSide,
  side: TsSide,
  uncalled: Readonly<Record<string, string>>,
  events: readonly string[] = EVENTS,
): string[] {
  const problems = [...rust.problems, ...side.problems];

  for (const site of side.sites) {
    const at = `${site.file}:${site.line}: ${site.cmd}`;
    if (!site.guarded) {
      problems.push(`${at} is not behind inTauri(): give it a browser (mock) branch`);
    }
    const command = rust.commands.get(site.cmd);
    if (command === undefined) {
      problems.push(`${at} is not a command generate_handler! registers`);
      continue;
    }
    if (!site.read) continue;
    const known = command.params.map((param) => param.key);
    for (const key of site.keys) {
      if (!known.includes(key)) {
        problems.push(
          `${at} sends "${key}", which it does not take${hint(key, known)}; Tauri drops it`,
        );
      }
    }
    for (const param of command.params) {
      if (!param.optional && !site.keys.includes(param.key)) {
        problems.push(`${at} omits "${param.key}", which it requires; Tauri refuses the call`);
      }
    }
    for (const [key, sent] of site.nested) {
      const param = command.params.find((p) => p.key === key);
      const shape = param === undefined ? null : rust.shape(param.type, command.file);
      if (shape === null) continue;
      if (typeof shape === 'string') {
        problems.push(`${at}: ${shape}`);
        continue;
      }
      const fields = shape.fields.flatMap((field) => field.keys);
      for (const field of sent) {
        if (shape.skipped.includes(field)) {
          problems.push(
            `${at} sends ${key}.${field}, which ${shape.label} skips when deserializing; Rust never reads it`,
          );
        } else if (!fields.includes(field)) {
          problems.push(
            `${at} sends ${key}.${field}, which ${shape.label} does not declare${hint(field, fields)}; serde drops it`,
          );
        }
      }
      for (const field of shape.fields) {
        if (field.required && !field.keys.some((k) => sent.includes(k))) {
          problems.push(`${at} omits ${key}.${field.keys[0]}, which ${shape.label} requires`);
        }
      }
    }
  }
  for (const heard of side.heard) {
    if (!heard.guarded) {
      problems.push(
        `${heard.file}:${heard.line}: "${heard.event}" is heard outside inTauri(): give it a browser branch`,
      );
    }
  }

  const reached = pathed(side);
  for (const name of rust.commands.keys()) {
    if (!reached.has(name) && !Object.hasOwn(uncalled, name)) {
      problems.push(
        `${name} has no production caller: call it from the app, or list it in UNCALLED with a reason`,
      );
    }
  }
  for (const [name, reason] of Object.entries(uncalled)) {
    if (!rust.commands.has(name)) {
      problems.push(
        `UNCALLED lists ${name}, which generate_handler! does not register: remove the entry`,
      );
    } else if (reached.has(name)) {
      problems.push(`UNCALLED lists ${name}, which the app calls: remove the entry`);
    }
    if (reason.trim().length < 20) {
      problems.push(
        `UNCALLED's reason for ${name} is under 20 characters: say why nothing calls it`,
      );
    }
  }

  const exports = new Map<
    string,
    { file: string; owner: string; cmds: string[]; hears: boolean }
  >();
  for (const { file, owner, cmd, hears } of [
    ...side.sites.map((site) => ({ ...site, hears: false })),
    ...side.heard.map((heard) => ({ ...heard, cmd: null, hears: true })),
  ]) {
    if (owner === null) continue;
    const id = `${file}#${owner}`;
    const entry = exports.get(id) ?? { file, owner, cmds: [], hears: false };
    if (cmd !== null) entry.cmds.push(cmd);
    entry.hears ||= hears;
    exports.set(id, entry);
  }
  for (const [id, { file, owner, cmds, hears }] of exports) {
    const flagged = !hears && cmds.every((cmd) => Object.hasOwn(uncalled, cmd));
    if (!side.called.has(id) && !flagged) {
      problems.push(
        `${file}: ${owner} talks to Rust, but no app file imports it: call it from the app, or delete it`,
      );
    }
  }

  const emitted = rust.events;
  const heard = new Set(side.heard.map((h) => h.event));
  for (const event of emitted) {
    if (!heard.has(event)) problems.push(`Rust emits "${event}", which no adapter listens to`);
  }
  for (const event of heard) {
    if (!emitted.has(event)) {
      problems.push(`an adapter listens to "${event}", which Rust never emits`);
    }
  }
  for (const event of emitted) {
    if (heard.has(event) && !events.includes(event)) {
      problems.push(`"${event}" is emitted and heard, but EVENTS does not name it: add it`);
    }
  }
  for (const event of events) {
    if (!emitted.has(event) && !heard.has(event)) {
      problems.push(`EVENTS names "${event}", which nothing emits or hears: remove it`);
    }
  }
  return problems;
}

// --- The real tree ----------------------------------------------------------

function readTree(root: string, keep: (path: string) => boolean, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (dir: string): void => {
    const entries = readdirSync(join(REPO, root, dir), { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (keep(path)) out.set(prefix + path, readFileSync(join(REPO, root, path), 'utf8'));
    }
  };
  visit('');
  return out;
}

let tree: { rust: RustSide; side: TsSide } | undefined;
function real(): { rust: RustSide; side: TsSide } {
  tree ??= {
    rust: rustSide(readTree('src-tauri/src', (path) => path.endsWith('.rs'))),
    side: tsSide(readTree('src', (path) => /\.tsx?$/.test(path), 'src/')),
  };
  return tree;
}

describe('the real tree', () => {
  it('the webview and Rust agree on every command', () => {
    const { rust, side } = real();
    expect(audit(rust, side, UNCALLED)).toEqual([]);
  });

  it('reads all four adapters, each with calls, so the scan is never vacuous', () => {
    const { rust, side } = real();
    expect(side.adapters).toEqual([
      'src/agent/agentIpc.ts',
      'src/lib/gitIpc.ts',
      'src/lib/ipc.ts',
      'src/lib/rootsIpc.ts',
    ]);
    for (const file of side.adapters) {
      expect(side.sites.filter((site) => site.file === file).length, file).toBeGreaterThan(0);
    }
    expect(rust.commands.get('unmount_root')?.params.map((param) => param.key)).toEqual(['rootId']);
  });

  it('follows a command registered two modules down (M55.9)', () => {
    const { rust } = real();
    for (const [name, keys] of [
      ['reveal_in_finder', ['vault', 'path']],
      ['open_in_default_app', ['vault', 'path']],
      ['open_agent_link', ['target', 'prompt']],
      ['write_clipboard', ['text']],
    ] as const) {
      const command = rust.commands.get(name);
      expect(command?.file, name).toBe('shell/open.rs');
      expect(command?.params.map((param) => param.key)).toEqual(keys);
    }
  });

  it('flags exactly the commands with no production caller, each with a reason', () => {
    const { rust, side } = real();
    const reached = pathed(side);
    const unreached = [...rust.commands.keys()].filter((name) => !reached.has(name));
    expect(unreached.sort()).toEqual(Object.keys(UNCALLED).sort());
    for (const reason of Object.values(UNCALLED)) expect(reason.length).toBeGreaterThanOrEqual(20);
  });

  it('Rust emits exactly the EVENTS, and the adapters listen to exactly those', () => {
    const { rust, side } = real();
    expect([...rust.events].sort()).toEqual([...EVENTS].sort());
    expect([...new Set(side.heard.map((heard) => heard.event))].sort()).toEqual([...EVENTS].sort());
  });

  it("sends run_agent's request as exactly AgentRequest's deserializable fields", () => {
    const { rust, side } = real();
    const command = rust.commands.get('run_agent');
    const param = command?.params.find((p) => p.key === 'request');
    const shape = command && param ? rust.shape(param.type, command.file) : null;
    if (shape === null || typeof shape === 'string') throw new Error(`AgentRequest: ${shape}`);
    const sites = side.sites.filter((site) => site.cmd === 'run_agent');
    expect(sites.map((site) => site.file)).toEqual(['src/agent/agentIpc.ts']);
    const sent = [...(sites[0].nested.get('request') ?? [])].sort();
    expect(sent).toEqual(shape.fields.flatMap((field) => field.keys).sort());
    expect([...shape.skipped].sort()).toEqual(['internal', 'mcp_token', 'mcp_url']);
  });

  // M91.2d: the Subagents switch rides `request.delegate`. Serde drops a key
  // AgentRequest does not declare, and Rust reads a request that names no
  // switch as on wherever a person watches, so a misspelt key would leave
  // Settings' Off doing nothing. Named here on both sides, with the words
  // each side spells the switch in.
  it("sends the Subagents switch as run_agent's request.delegate, in DelegateCeiling's words", () => {
    const { rust, side } = real();
    const command = rust.commands.get('run_agent');
    const param = command?.params.find((p) => p.key === 'request');
    const shape = command && param ? rust.shape(param.type, command.file) : null;
    if (shape === null || typeof shape === 'string') throw new Error(`AgentRequest: ${shape}`);
    expect(shape.fields).toContainEqual({ keys: ['delegate'], required: false });
    const site = side.sites.find((s) => s.cmd === 'run_agent');
    expect([...(site?.nested.get('request') ?? [])]).toContain('delegate');
    // Rust reads the key as a DelegateCeiling, whose words are its variants
    // in lowercase, and those are TS's.
    const request = readFileSync(join(REPO, RS, 'agent/mod.rs'), 'utf8');
    expect(request).toMatch(
      /\bpub delegate: Option<(?:crate::policy::tool_approval::)?DelegateCeiling>,/,
    );
    const policy = readFileSync(join(REPO, RS, 'policy/tool_approval.rs'), 'utf8');
    const ceiling =
      /#\[serde\(rename_all = "lowercase"\)\]\s*pub enum DelegateCeiling \{([^}]*)\}/.exec(policy);
    const variants = (ceiling?.[1] ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[A-Z]\w*,?$/.test(line))
      .map((line) => line.replace(/,$/, '').toLowerCase());
    expect(variants).toEqual([...DELEGATE_CEILINGS]);
    // The adapter sends RunOptions.delegate as it is, a DelegateCeiling or
    // null, which leaves the default to Rust.
    const file = 'src/agent/agentIpc.ts';
    const sf = parse(file, readFileSync(join(REPO, file), 'utf8'));
    const sends: string[] = [];
    const typed: (string | undefined)[] = [];
    walk(sf, (node) => {
      if (ts.isPropertyAssignment(node) && keyOf(node) === 'delegate') {
        const outer = node.parent.parent;
        if (ts.isPropertyAssignment(outer) && keyOf(outer) === 'request') {
          sends.push(node.initializer.getText(sf));
        }
      }
      if (ts.isInterfaceDeclaration(node) && node.name.text === 'RunOptions') {
        for (const member of node.members) {
          if (ts.isPropertySignature(member) && member.name.getText(sf) === 'delegate') {
            typed.push(member.type?.getText(sf));
          }
        }
      }
    });
    expect(sends).toEqual(['options.delegate ?? null']);
    expect(typed).toEqual(['DelegateCeiling']);
  });

  // M91.6: a branch's fork is a struct a level below the audit's reach, so
  // its keys are read here: the object literal the adapter sends as
  // `request.fork`, against the struct serde reads it into. Both keys are
  // required, so a misspelt one refuses the whole request rather than
  // running the branch as a thread of its own.
  it("sends run_agent's request.fork as exactly ForkRequest's fields", () => {
    const { rust } = real();
    const shape = rust.shape('transcript::ForkRequest', 'agent/mod.rs');
    if (shape === null || typeof shape === 'string') throw new Error(`ForkRequest: ${shape}`);
    expect(shape.fields).toEqual([
      { keys: ['from'], required: true },
      { keys: ['at'], required: true },
    ]);
    const field = shape.fields.map((f) => f.keys[0]);
    const file = 'src/agent/agentIpc.ts';
    const sf = parse(file, readFileSync(join(REPO, file), 'utf8'));
    const sent: (string | { problem: string })[][] = [];
    walk(sf, (node) => {
      if (!ts.isPropertyAssignment(node) || keyOf(node) !== 'fork') return;
      const request = node.parent.parent;
      if (!ts.isPropertyAssignment(request) || keyOf(request) !== 'request') return;
      walk(node.initializer, (inner) => {
        if (ts.isObjectLiteralExpression(inner)) sent.push(inner.properties.map(keyOf));
      });
    });
    expect(sent).toEqual([field]);
  });

  // M92.12: the Changes heal names its session as Rust spells the parameter.
  // Tauri would refuse a call that omits it, but a misspelt key beside a
  // spelled one is dropped without a word; the audit catches that, and this
  // holds the pair and the one adapter that sends it, which the app reaches.
  it('sends conversation_changes the vault and the session, from gitIpc alone', () => {
    const { rust, side } = real();
    const command = rust.commands.get('conversation_changes');
    expect(command?.file).toBe('lib.rs');
    expect(command?.params.map((param) => [param.key, param.optional])).toEqual([
      ['vault', false],
      ['sessionId', false],
    ]);
    const sites = side.sites.filter((site) => site.cmd === 'conversation_changes');
    expect(sites.map((site) => [site.file, site.owner, [...site.keys].sort()])).toEqual([
      ['src/lib/gitIpc.ts', 'conversationChanges', ['sessionId', 'vault']],
    ]);
    expect(side.called.has('src/lib/gitIpc.ts#conversationChanges')).toBe(true);
  });
});

// --- Negative controls, on inline fixtures -----------------------------------

const LIB_RS = `pub mod agent;

/// What changed since a sequence number.
#[tauri::command(async)]
fn converge(app: tauri::AppHandle, vault: String, from_seq: Option<u64>) -> Result<(), String> {
    Ok(())
}

#[tauri::command(async)]
fn run_agent(
    app: tauri::AppHandle,
    state: tauri::State<'_, agent::AgentState>,
    vault: String,
    request: agent::AgentRequest,
) -> Result<u64, String> {
    Ok(1)
}

pub fn run() {
    tauri::Builder::default().invoke_handler(tauri::generate_handler![
        converge,
        // The agent's door, in a comment, with a comma.
        run_agent,
    ]);
}
`;

const AGENT_RS = `use tauri::Emitter;

pub const AGENT_EVENT: &str = "cerebro://agent";

pub struct AgentState;

/// One run's request.
#[derive(Deserialize)]
pub struct AgentRequest {
    pub message: String,
    /// Folders the run may read.
    pub read_scope: Option<Vec<String>>,
    #[serde(skip_deserializing)]
    pub internal: bool,
}

fn tell(app: &tauri::AppHandle) {
    let _ = app.emit(AGENT_EVENT, ());
}
`;

const IPC_TS = `import * as mock from './mockIpc';

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function invokeTauri<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

export function converge(vault: string, fromSeq?: number): Promise<void> {
  return inTauri()
    ? invokeTauri('converge', { vault, fromSeq: fromSeq ?? null })
    : mock.converge(vault, fromSeq);
}

export async function runAgent(vault: string, readScope: string[] | null): Promise<number> {
  if (!inTauri()) return mock.runAgent(vault);
  return invokeTauri<number>('run_agent', {
    vault,
    request: { message: 'go', read_scope: readScope },
  });
}

export async function onAgentEvent(handler: () => void): Promise<() => void> {
  if (!inTauri()) return () => undefined;
  const { listen } = await import('@tauri-apps/api/event');
  return listen('cerebro://agent', () => handler());
}
`;

const MOCK_TS = `export async function converge(_vault: string, _fromSeq?: number): Promise<void> {}
export async function runAgent(_vault: string): Promise<number> {
  return 1;
}
`;

const PANEL_TSX = `import { converge, onAgentEvent } from '@/lib/ipc';
import * as ipc from '../lib/ipc';

export const wire = () => [converge, onAgentEvent, ipc.runAgent];
`;

interface Fixture {
  rust: Map<string, string>;
  ts: Map<string, string>;
}

function fixture(): Fixture {
  return {
    rust: new Map([
      ['lib.rs', LIB_RS],
      ['agent/mod.rs', AGENT_RS],
    ]),
    ts: new Map([
      ['src/lib/ipc.ts', IPC_TS],
      ['src/lib/mockIpc.ts', MOCK_TS],
      ['src/app/Panel.tsx', PANEL_TSX],
    ]),
  };
}

/** One edit to one fixture file; a search that misses fails the test. */
function edit(files: Map<string, string>, path: string, from: string, to: string): void {
  const text = files.get(path);
  if (text === undefined || !text.includes(from))
    throw new Error(`fixture: ${path} has no ${from}`);
  files.set(path, text.replace(from, to));
}

const FIXTURE_EVENTS = ['cerebro://agent'];

/** The audit's messages with line numbers dropped, so a fixture can grow. */
function check(
  f: Fixture,
  uncalled: Readonly<Record<string, string>> = {},
  events: readonly string[] = FIXTURE_EVENTS,
): string[] {
  return audit(rustSide(f.rust), tsSide(f.ts), uncalled, events).map((p) =>
    p.replace(/:\d+:/g, ':'),
  );
}

const REASON = 'kept for a surface that has not landed yet';

describe('the fixture', () => {
  it('audits clean as written', () => {
    expect(check(fixture())).toEqual([]);
  });

  it('never expects tauri::State or the AppHandle', () => {
    const rust = rustSide(fixture().rust);
    expect(rust.commands.get('run_agent')?.params.map((param) => param.key)).toEqual([
      'vault',
      'request',
    ]);
    expect(rust.commands.get('converge')?.params.map((param) => param.key)).toEqual([
      'vault',
      'fromSeq',
    ]);
  });
});

describe('the payload keys', () => {
  it('names an unknown command', () => {
    const f = fixture();
    edit(f.ts, 'src/lib/ipc.ts', "'converge', {", "'converged', {");
    expect(check(f)).toEqual([
      'src/lib/ipc.ts: converged is not a command generate_handler! registers',
      'converge has no production caller: call it from the app, or list it in UNCALLED with a reason',
    ]);
  });

  it('names an unknown key, with the spelling Rust uses', () => {
    const f = fixture();
    edit(f.ts, 'src/lib/ipc.ts', 'fromSeq: fromSeq', 'from_seq: fromSeq');
    expect(check(f)).toEqual([
      'src/lib/ipc.ts: converge sends "from_seq", which it does not take (Rust spells it "fromSeq"); Tauri drops it',
    ]);
  });

  it('names a missing required key', () => {
    const f = fixture();
    edit(f.ts, 'src/lib/ipc.ts', '{ vault, fromSeq', '{ fromSeq');
    expect(check(f)).toEqual([
      'src/lib/ipc.ts: converge omits "vault", which it requires; Tauri refuses the call',
    ]);
  });

  it("catches a nested readScope, with the request's own spelling", () => {
    const f = fixture();
    edit(f.ts, 'src/lib/ipc.ts', 'read_scope: readScope', 'readScope');
    expect(check(f)).toEqual([
      'src/lib/ipc.ts: run_agent sends request.readScope, which agent::AgentRequest does not declare (Rust spells it "read_scope"); serde drops it',
    ]);
  });

  it('names a missing required field', () => {
    const f = fixture();
    edit(f.ts, 'src/lib/ipc.ts', "message: 'go', ", '');
    expect(check(f)).toEqual([
      'src/lib/ipc.ts: run_agent omits request.message, which agent::AgentRequest requires',
    ]);
  });

  it('names a skip_deserializing field that is sent', () => {
    const f = fixture();
    edit(f.ts, 'src/lib/ipc.ts', 'read_scope: readScope', 'read_scope: readScope, internal: true');
    expect(check(f)).toEqual([
      'src/lib/ipc.ts: run_agent sends request.internal, which agent::AgentRequest skips when deserializing; Rust never reads it',
    ]);
  });

  it('applies a camelCase rename_all to the fields', () => {
    const f = fixture();
    edit(
      f.rust,
      'agent/mod.rs',
      '#[derive(Deserialize)]',
      '#[derive(Deserialize)]\n#[serde(rename_all = "camelCase")]',
    );
    expect(check(f)).toEqual([
      'src/lib/ipc.ts: run_agent sends request.read_scope, which agent::AgentRequest does not declare (Rust spells it "readScope"); serde drops it',
    ]);
  });

  it('reads a defaulted field as optional', () => {
    const f = fixture();
    edit(
      f.rust,
      'agent/mod.rs',
      '    pub message: String,',
      '    #[serde(default)]\n    pub message: String,',
    );
    edit(f.ts, 'src/lib/ipc.ts', "message: 'go', ", '');
    expect(check(f)).toEqual([]);
  });

  it('refuses #[serde(flatten)]', () => {
    const f = fixture();
    edit(
      f.rust,
      'agent/mod.rs',
      '    pub internal: bool,',
      '    pub internal: bool,\n    #[serde(flatten)]\n    pub extra: Extra,',
    );
    expect(check(f)).toEqual([
      "src/lib/ipc.ts: run_agent: agent::AgentRequest's #[serde(flatten)] on extra is refused: the scan cannot see the keys it pulls in",
    ]);
  });

  it('refuses a serde attribute it cannot read', () => {
    const f = fixture();
    edit(
      f.rust,
      'agent/mod.rs',
      '    pub message: String,',
      '    #[serde(borrow)]\n    pub message: String,',
    );
    expect(check(f)).toEqual([
      "src/lib/ipc.ts: run_agent: agent::AgentRequest's #[serde(borrow)] on message is refused: the scan reads rename, alias, default, skip and skip_deserializing",
    ]);
  });
});

describe('the call sites', () => {
  it('names an unguarded invoke', () => {
    const f = fixture();
    edit(
      f.ts,
      'src/lib/ipc.ts',
      "return inTauri()\n    ? invokeTauri('converge', { vault, fromSeq: fromSeq ?? null })\n    : mock.converge(vault, fromSeq);",
      "return invokeTauri('converge', { vault, fromSeq: fromSeq ?? null });",
    );
    expect(check(f)).toEqual([
      'src/lib/ipc.ts: converge is not behind inTauri(): give it a browser (mock) branch',
    ]);
  });

  it('names an unguarded listen', () => {
    const f = fixture();
    edit(f.ts, 'src/lib/ipc.ts', '  if (!inTauri()) return () => undefined;\n', '');
    expect(check(f)).toEqual([
      'src/lib/ipc.ts: "cerebro://agent" is heard outside inTauri(): give it a browser branch',
    ]);
  });

  it('refuses a command name that is not a literal', () => {
    const f = fixture();
    edit(f.ts, 'src/lib/ipc.ts', "invokeTauri('converge', {", 'invokeTauri(CONVERGE, {');
    edit(
      f.ts,
      'src/lib/ipc.ts',
      'function inTauri',
      "const CONVERGE = 'converge';\n\nfunction inTauri",
    );
    expect(check(f)).toEqual([
      'src/lib/ipc.ts: the command name must be a string literal',
      'converge has no production caller: call it from the app, or list it in UNCALLED with a reason',
    ]);
  });

  it('refuses a spread payload', () => {
    const f = fixture();
    edit(f.ts, 'src/lib/ipc.ts', '{ vault, fromSeq', '{ ...{ vault }, fromSeq');
    expect(check(f)).toEqual([
      "src/lib/ipc.ts: converge's payload spreads an object: name every key",
    ]);
  });

  it('refuses a computed key', () => {
    const f = fixture();
    edit(f.ts, 'src/lib/ipc.ts', '{ vault, fromSeq', "{ ['vault']: vault, fromSeq");
    expect(check(f)).toEqual([
      "src/lib/ipc.ts: converge's payload has a computed key: name every key",
    ]);
  });

  it('refuses a payload passed as a variable', () => {
    const f = fixture();
    edit(
      f.ts,
      'src/lib/ipc.ts',
      "invokeTauri('converge', { vault, fromSeq: fromSeq ?? null })",
      "invokeTauri('converge', payload)",
    );
    edit(
      f.ts,
      'src/lib/ipc.ts',
      'export function converge(vault: string, fromSeq?: number): Promise<void> {',
      'export function converge(vault: string, fromSeq?: number): Promise<void> {\n  const payload = { vault, fromSeq };',
    );
    expect(check(f)).toEqual([
      "src/lib/ipc.ts: converge's payload must be an object literal, so its keys can be read",
    ]);
  });

  it('refuses a raw invoke outside invokeTauri', () => {
    const f = fixture();
    edit(
      f.ts,
      'src/lib/ipc.ts',
      'export function converge',
      "export async function sneak(): Promise<void> {\n  if (!inTauri()) return;\n  const { invoke } = await import('@tauri-apps/api/core');\n  await invoke('converge', { vault: 'v' });\n}\n\nexport function converge",
    );
    expect(check(f)).toEqual([
      'src/lib/ipc.ts: invoke is called outside invokeTauri: call invokeTauri',
    ]);
  });

  it('refuses an invokeTauri that does not hand invoke its own cmd and args', () => {
    const f = fixture();
    edit(
      f.ts,
      'src/lib/ipc.ts',
      'return invoke<T>(cmd, args);',
      "return invoke<T>('converge', args);",
    );
    expect(check(f)).toContain('src/lib/ipc.ts: invokeTauri must hand invoke its own cmd and args');
  });

  it('refuses a renamed binding, and keeps reading through it', () => {
    const f = fixture();
    edit(f.ts, 'src/lib/ipc.ts', 'const { invoke } =', 'const { invoke: call } =');
    edit(f.ts, 'src/lib/ipc.ts', 'return invoke<T>(cmd, args);', 'return call<T>(cmd, args);');
    expect(check(f)).toEqual([
      'src/lib/ipc.ts: invoke from @tauri-apps/api/core is bound as call: bind it by its own name',
    ]);
  });

  it('refuses a module taken whole', () => {
    const f = fixture();
    edit(f.ts, 'src/lib/ipc.ts', 'const { listen } = await', 'const events = await');
    edit(
      f.ts,
      'src/lib/ipc.ts',
      "return listen('cerebro://agent'",
      "return events.listen('cerebro://agent'",
    );
    expect(check(f)).toEqual([
      'src/lib/ipc.ts: @tauri-apps/api/event is taken whole: destructure the function by its own name',
      'Rust emits "cerebro://agent", which no adapter listens to',
    ]);
  });

  it('refuses a door the test cannot check, and a re-export', () => {
    const f = fixture();
    edit(
      f.ts,
      'src/lib/ipc.ts',
      "import * as mock from './mockIpc';",
      "import * as mock from './mockIpc';\nimport { emit } from '@tauri-apps/api/event';\nexport { invoke } from '@tauri-apps/api/core';\nvoid emit;",
    );
    expect(check(f)).toEqual([
      'src/lib/ipc.ts: emit from @tauri-apps/api/event is a door this test cannot check: reach Rust through invoke or listen',
      'src/lib/ipc.ts: re-exports a Tauri module: only the adapters may reach Tauri',
    ]);
  });

  it('refuses invoke passed around as a value', () => {
    const f = fixture();
    edit(
      f.ts,
      'src/lib/ipc.ts',
      'return invoke<T>(cmd, args);',
      'const call = invoke;\n  return call<T>(cmd, args);',
    );
    expect(check(f)).toContain(
      'src/lib/ipc.ts: invoke is passed around as a value: call it where it is bound',
    );
  });

  it('refuses a call outside an exported function', () => {
    const f = fixture();
    edit(
      f.ts,
      'src/lib/ipc.ts',
      'export function converge',
      "function helper(): Promise<void> {\n  return inTauri() ? invokeTauri('converge', { vault: 'v' }) : Promise.resolve();\n}\n\nexport function converge",
    );
    expect(check(f)).toEqual(['src/lib/ipc.ts: converge is invoked outside an exported function']);
  });

  it('refuses an exported forwarder', () => {
    const f = fixture();
    edit(f.ts, 'src/lib/ipc.ts', 'async function invokeTauri', 'export async function invokeTauri');
    expect(check(f)).toEqual([
      'src/lib/ipc.ts: invokeTauri forwards to Rust and is exported: keep it inside src/lib/ipc.ts',
    ]);
  });

  it('follows an invokeRootGit-shaped forwarder, and its guard', () => {
    const f = fixture();
    edit(
      f.rust,
      'lib.rs',
      '        run_agent,\n',
      '        run_agent,\n        roots_git_commands::root_git_pulse,\n',
    );
    f.rust.set(
      'roots_git_commands.rs',
      '#[tauri::command(async)]\npub fn root_git_pulse(\n    app: tauri::AppHandle,\n    root_id: String,\n) -> Result<(), String> {\n    Ok(())\n}\n',
    );
    edit(
      f.ts,
      'src/lib/ipc.ts',
      'export function converge',
      [
        'async function invokeRootGit<T>(',
        '  cmd: string,',
        '  args: Record<string, unknown>,',
        '  fallback: () => Promise<T>,',
        '): Promise<T> {',
        '  if (!inTauri()) return fallback();',
        '  try {',
        '    return await invokeTauri<T>(cmd, args);',
        '  } catch (err) {',
        '    throw err;',
        '  }',
        '}',
        '',
        'export function rootGitPulse(rootId: string): Promise<void> {',
        "  return invokeRootGit('root_git_pulse', { root_id: rootId }, () => Promise.resolve());",
        '}',
        '',
        'export function converge',
      ].join('\n'),
    );
    edit(
      f.ts,
      'src/app/Panel.tsx',
      '{ converge, onAgentEvent }',
      '{ converge, onAgentEvent, rootGitPulse }',
    );
    expect(check(f)).toEqual([
      'src/lib/ipc.ts: root_git_pulse sends "root_id", which it does not take (Rust spells it "rootId"); Tauri drops it',
      'src/lib/ipc.ts: root_git_pulse omits "rootId", which it requires; Tauri refuses the call',
    ]);
  });

  it('reads a multi-line invokeTauri<{…}>(…)', () => {
    const f = fixture();
    edit(
      f.ts,
      'src/lib/ipc.ts',
      "    ? invokeTauri('converge', { vault, fromSeq: fromSeq ?? null })",
      "    ? invokeTauri<{\n        path: string;\n        memory_files: number;\n      }>('converge', { vault, extra: 1 }).then(() => undefined)",
    );
    expect(check(f)).toEqual([
      'src/lib/ipc.ts: converge sends "extra", which it does not take; Tauri drops it',
    ]);
  });
});

describe('the production callers', () => {
  it('names a command with no production caller, and its dead export', () => {
    const f = fixture();
    edit(f.ts, 'src/app/Panel.tsx', '{ converge, onAgentEvent }', '{ onAgentEvent }');
    edit(f.ts, 'src/app/Panel.tsx', '[converge, ', '[');
    expect(check(f)).toEqual([
      'converge has no production caller: call it from the app, or list it in UNCALLED with a reason',
      'src/lib/ipc.ts: converge talks to Rust, but no app file imports it: call it from the app, or delete it',
    ]);
    expect(check(f, { converge: REASON })).toEqual([]);
  });

  it('names a stale UNCALLED entry', () => {
    expect(check(fixture(), { converge: REASON })).toEqual([
      'UNCALLED lists converge, which the app calls: remove the entry',
    ]);
    expect(check(fixture(), { gone: REASON })).toEqual([
      'UNCALLED lists gone, which generate_handler! does not register: remove the entry',
    ]);
    const f = fixture();
    edit(f.ts, 'src/app/Panel.tsx', '{ converge, onAgentEvent }', '{ onAgentEvent }');
    edit(f.ts, 'src/app/Panel.tsx', '[converge, ', '[');
    expect(check(f, { converge: 'later' })).toEqual([
      "UNCALLED's reason for converge is under 20 characters: say why nothing calls it",
    ]);
  });

  it('counts neither a test nor a mock of the same name as a caller, and excuses no listen', () => {
    const f = fixture();
    edit(f.ts, 'src/app/Panel.tsx', '{ converge, onAgentEvent }', '{ converge }');
    edit(f.ts, 'src/app/Panel.tsx', ', onAgentEvent, ', ', ');
    f.ts.set(
      'src/app/Panel.test.tsx',
      "import { onAgentEvent } from '@/lib/ipc';\nvoid onAgentEvent;\n",
    );
    f.ts.set(
      'src/app/Other.tsx',
      "import { onAgentEvent } from '@/lib/mockIpc';\nexport const o = onAgentEvent;\n",
    );
    // A listen-only export invokes no command UNCALLED could flag.
    expect(check(f)).toEqual([
      'src/lib/ipc.ts: onAgentEvent talks to Rust, but no app file imports it: call it from the app, or delete it',
    ]);
  });

  it('counts a namespace read off an await import()', () => {
    const f = fixture();
    f.ts.set(
      'src/app/Panel.tsx',
      "export async function wire() {\n  const ipc = await import('@/lib/ipc');\n  return [ipc.converge, ipc.onAgentEvent, ipc.runAgent];\n}\n",
    );
    expect(check(f)).toEqual([]);
  });
});

describe('the Rust commands', () => {
  it('reads a doc comment between the attribute and the fn', () => {
    const f = fixture();
    edit(
      f.rust,
      'lib.rs',
      '#[tauri::command(async)]\nfn converge(',
      '#[tauri::command(async)]\n/// Stop ONE run.\n/// A second line.\n#[expect(clippy::needless_pass_by_value, reason = "Tauri hands it over")]\nfn converge(',
    );
    expect(check(f)).toEqual([]);
    expect(
      rustSide(f.rust)
        .commands.get('converge')
        ?.params.map((p) => p.key),
    ).toEqual(['vault', 'fromSeq']);
  });

  it('refuses rename_all, and keeps reading the fn', () => {
    const f = fixture();
    edit(
      f.rust,
      'lib.rs',
      '#[tauri::command(async)]\nfn converge(',
      '#[tauri::command(async, rename_all = "snake_case")]\nfn converge(',
    );
    expect(check(f)).toEqual([
      'src-tauri/src/lib.rs: #[tauri::command(async, rename_all = "snake_case")] is refused: Tauri must take the command\'s name and keys from the fn as written',
    ]);
  });

  it('refuses a bare #[command]', () => {
    const f = fixture();
    edit(f.rust, 'lib.rs', '#[tauri::command(async)]\nfn converge(', '#[command]\nfn converge(');
    expect(check(f)).toEqual([
      'src-tauri/src/lib.rs: a bare #[command] is refused: write #[tauri::command]',
    ]);
  });

  it('names an unregistered command', () => {
    const f = fixture();
    edit(
      f.rust,
      'lib.rs',
      'pub fn run()',
      '#[tauri::command(async)]\nfn orphan() {}\n\npub fn run()',
    );
    expect(check(f)).toEqual([
      'src-tauri/src/lib.rs: #[tauri::command] fn orphan is not in generate_handler!',
    ]);
  });

  it('names an entry with no fn', () => {
    const f = fixture();
    edit(
      f.rust,
      'lib.rs',
      '        run_agent,\n',
      '        run_agent,\n        git_commands::ghost,\n',
    );
    expect(check(f)).toEqual([
      'src-tauri/src/lib.rs: generate_handler! registers git_commands::ghost, but src-tauri/src/git_commands.rs or src-tauri/src/git_commands/mod.rs holds no #[tauri::command] fn ghost',
    ]);
  });

  it('names a duplicate entry', () => {
    const f = fixture();
    edit(f.rust, 'lib.rs', '        run_agent,\n', '        run_agent,\n        converge,\n');
    expect(check(f)).toEqual(['src-tauri/src/lib.rs: generate_handler! registers converge twice']);
  });

  it('refuses a bare injected type the crate also defines', () => {
    const f = fixture();
    edit(
      f.rust,
      'lib.rs',
      "state: tauri::State<'_, agent::AgentState>",
      "state: State<'_, agent::AgentState>",
    );
    edit(
      f.rust,
      'agent/mod.rs',
      'pub struct AgentState;',
      'pub struct AgentState;\n\npub struct State;',
    );
    expect(check(f)).toEqual([
      "src-tauri/src/lib.rs: run_agent's state is typed State, which is not plainly Tauri's: write tauri::State",
    ]);
  });

  it('refuses a parameter that is not snake_case', () => {
    const f = fixture();
    edit(f.rust, 'lib.rs', 'from_seq: Option<u64>', 'fromSeq: Option<u64>');
    expect(check(f)).toEqual([
      "src-tauri/src/lib.rs: converge's parameter fromSeq is not snake_case, so its key is a guess",
    ]);
  });
});

describe('the events', () => {
  it('names an event emitted but not heard, and one heard but not emitted', () => {
    const f = fixture();
    edit(
      f.rust,
      'agent/mod.rs',
      '    let _ = app.emit(AGENT_EVENT, ());',
      '    let _ = app.emit(AGENT_EVENT, ());\n    let _ = app.emit("cerebro://other", ());',
    );
    edit(
      f.ts,
      'src/lib/ipc.ts',
      "return listen('cerebro://agent', () => handler());",
      "await listen('cerebro://ghost', () => handler());\n  return listen('cerebro://agent', () => handler());",
    );
    expect(check(f)).toEqual([
      'Rust emits "cerebro://other", which no adapter listens to',
      'an adapter listens to "cerebro://ghost", which Rust never emits',
    ]);
  });

  it('holds EVENTS to what is emitted and heard', () => {
    expect(check(fixture(), {}, [])).toEqual([
      '"cerebro://agent" is emitted and heard, but EVENTS does not name it: add it',
    ]);
    expect(check(fixture(), {}, ['cerebro://agent', 'cerebro://gone'])).toEqual([
      'EVENTS names "cerebro://gone", which nothing emits or hears: remove it',
    ]);
  });

  it('refuses emit_to', () => {
    const f = fixture();
    edit(
      f.rust,
      'agent/mod.rs',
      '    let _ = app.emit(AGENT_EVENT, ());',
      '    let _ = app.emit(AGENT_EVENT, ());\n    let _ = app.emit_to("main", AGENT_EVENT, ());',
    );
    expect(check(f)).toEqual([
      'src-tauri/src/agent/mod.rs: .emit_to( is refused: emit to every listener with .emit(NAME, payload)',
    ]);
  });

  it('refuses an event name it cannot resolve', () => {
    const f = fixture();
    edit(
      f.rust,
      'agent/mod.rs',
      '    let _ = app.emit(AGENT_EVENT, ());',
      '    let _ = app.emit(AGENT_EVENT, ());\n    let _ = app.emit(MISSING_EVENT, ());',
    );
    expect(check(f)).toEqual([
      "src-tauri/src/agent/mod.rs: .emit's event is neither a string literal nor one const &str",
    ]);
  });
});
