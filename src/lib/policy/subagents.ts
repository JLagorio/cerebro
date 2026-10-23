/**
 * `shared/policy/subagents.v1.json` — how far Claude Code's subagents may go
 * in a run, TS side (M91.1, M91.2a).
 *
 * The SAME BYTES the Rust core compiles in with `include_str!`, imported raw
 * by vite so the digest test hashes exactly what was loaded. The artifact
 * names the Claude Code it was measured on and the environment every run but
 * Cerebro's own constructs is started with: subagents in the foreground, one
 * level deep, two at once and eight a session, and none of Claude Code's
 * built-in agent types (M91.2a). Since M91.2a it also names what only a
 * seated run adds (`seated_env`: the todo list, never the shared task list),
 * the agent types Cerebro defines itself (`presets`: each one's sentence, the
 * reading toolsets it holds and the web tools it holds where its run does)
 * and the settings that harden every run's Claude Code (`settings`: no bypass
 * mode, no auto mode). Rust sets the environment on the child
 * (`agent::cli_command`); this module is the second strict reader, refusal
 * for refusal and in the same words, so the browser mock and the surfaces
 * read the bounds and the types the CLI runs under.
 *
 * @see src-tauri/src/policy/subagents.rs — the Rust reader, rule for rule.
 */

import raw from '../../../shared/policy/subagents.v1.json?raw';
import { isAgentType, TOOL_APPROVAL, WEB_AXIS } from './toolApproval';
import { TOOLS, type CliTool, type ToolsManifest } from './tools';

export const SUBAGENTS_PATH = 'shared/policy/subagents.v1.json';
export const SUBAGENTS_DIGEST_PATH = 'shared/policy/subagents.v1.sha256';

/** The format this build reads. */
export const FORMAT = 1;

/** The longest value a variable may hold. */
const VALUE_CHARS = 64;

/** The longest sentence a preset describes itself with, in characters. */
export const DESCRIPTION_CHARS = 300;

/** The one value each hardening setting takes: Claude Code's schema offers
 * no other. */
const DISABLE = 'disable';

/** One agent type Cerebro defines (M91.2a). It gathers and never acts: it
 * holds reading toolsets only, and the web only where its run holds it. */
export interface Preset {
  /** The type's name, as argv and an init carry it (`isAgentType`). */
  name: string;
  /** The one sentence the main model reads when it picks a type. It names no
   * tool and no retired term. */
  description: string;
  /** The manifest's toolsets it holds, each one of read_only rows on
   * non-writing doors. */
  toolsets: string[];
  /** The CLI's own tools it holds where its run holds them, by their rows'
   * names: each one a tool the web ceiling holds, so none of them writes or
   * runs anything. */
  web_when_held: string[];
}

/** The hardening every run's settings file carries (M91.2a), spelled as
 * Claude Code's settings schema spells it. */
export interface Settings {
  permissions: { disableBypassPermissionsMode: string };
  disableAutoMode: string;
}

export interface Subagents {
  format: number;
  /** The Claude Code these variables were measured on, `N.N.N`. */
  cli_version: string;
  /** Variable to value, in ASCII order of the names; each one Claude Code's
   * own (`CLAUDE_` and capitals). */
  env: Record<string, string>;
  /** What a seated run adds to `env` (M91.2a), by the same rules, and none of
   * `env`'s names. */
  seated_env: Record<string, string>;
  /** The agent types Cerebro defines (M91.2a), in the order argv names them.
   * The tool-approval table's `agent_types.allowed` names the same types. */
  presets: Preset[];
  /** What every run's settings file hardens Claude Code with (M91.2a). */
  settings: Settings;
}

function refusal(subject: string, field: string, problem: string): Error {
  return new Error(`${SUBAGENTS_PATH}: ${subject}: \`${field}\` ${problem}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A struct with exactly `keys`, as `deny_unknown_fields` reads one: an
 * unknown field fails, and so does a missing one. */
function exactly(value: unknown, where: string, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${SUBAGENTS_PATH}: invalid type: ${where} must be a map`);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`${SUBAGENTS_PATH}: unknown field \`${key}\``);
  }
  for (const key of keys) {
    if (!(key in value)) throw new Error(`${SUBAGENTS_PATH}: missing field \`${key}\``);
  }
  return value;
}

/** A map of text, as serde reads `env` and `seated_env`. */
function textMap(value: unknown, field: string): void {
  if (!isRecord(value)) throw new Error(`${SUBAGENTS_PATH}: invalid type: ${field} must be a map`);
  for (const [name, setting] of Object.entries(value)) {
    if (typeof setting !== 'string') {
      throw new Error(`${SUBAGENTS_PATH}: invalid type: ${field} ${name} must be text`);
    }
  }
}

/** A list of text, as serde reads a preset's toolsets and tools. */
function textList(value: unknown, field: string): void {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${SUBAGENTS_PATH}: invalid type: ${field} must be a list of names`);
  }
}

function text(value: unknown, field: string): void {
  if (typeof value !== 'string') {
    throw new Error(`${SUBAGENTS_PATH}: invalid type: ${field} must be text`);
  }
}

/** The shape serde reads on the Rust side: exactly six fields, a whole
 * format, a text version, two maps of text, the presets and the settings,
 * each struct with exactly its own fields. */
function checkShape(value: unknown): Subagents {
  const top = exactly(value, 'the artifact', [
    'format',
    'cli_version',
    'env',
    'seated_env',
    'presets',
    'settings',
  ]);
  if (!Number.isSafeInteger(top.format) || (top.format as number) < 0) {
    throw new Error(`${SUBAGENTS_PATH}: invalid type: format must be a whole number`);
  }
  text(top.cli_version, 'cli_version');
  textMap(top.env, 'env');
  textMap(top.seated_env, 'seated_env');
  if (!Array.isArray(top.presets)) {
    throw new Error(`${SUBAGENTS_PATH}: invalid type: presets must be a list`);
  }
  for (const one of top.presets) {
    const preset = exactly(one, 'a preset', ['name', 'description', 'toolsets', 'web_when_held']);
    text(preset.name, 'name');
    text(preset.description, 'description');
    textList(preset.toolsets, 'toolsets');
    textList(preset.web_when_held, 'web_when_held');
  }
  const settings = exactly(top.settings, 'settings', ['permissions', 'disableAutoMode']);
  text(settings.disableAutoMode, 'disableAutoMode');
  const permissions = exactly(settings.permissions, 'permissions', [
    'disableBypassPermissionsMode',
  ]);
  text(permissions.disableBypassPermissionsMode, 'disableBypassPermissionsMode');
  return value as Subagents;
}

const VERSION = /^\d+\.\d+\.\d+$/;
/** `CLAUDE_`, then capitals, digits and underscores. */
const CLAUDE_VARIABLE = /^CLAUDE_[A-Z0-9_]+$/;
/** Letters, digits, dots, dashes and underscores. */
const PLAIN_VALUE = /^[A-Za-z0-9._-]+$/;

/** A control character (Rust's `char::is_control`) or a line separator. */
function breaksTheLine(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}

/** One sentence on one line: a capital letter first, a full stop last, at
 * most DESCRIPTION_CHARS characters, and no control character or line
 * separator anywhere. */
function isSentence(description: string): boolean {
  const chars = [...description];
  return (
    chars.length >= 1 &&
    chars.length <= DESCRIPTION_CHARS &&
    /^[A-Z]/.test(description) &&
    description.endsWith('.') &&
    !chars.some(breaksTheLine)
  );
}

/** The variables of `field` (`env` or `seated_env`), as subagents.rs's
 * `check_variables`: Claude Code's own names in ASCII order with plain
 * values, and none that `outer` already sets. */
function checkVariables(
  field: string,
  variables: Record<string, string>,
  outer: Record<string, string> | null,
): void {
  let previous: string | null = null;
  for (const [name, value] of Object.entries(variables)) {
    const subject = `${field} ${name}`;
    if (!CLAUDE_VARIABLE.test(name)) {
      throw refusal(
        subject,
        field,
        'must name a Claude Code variable: CLAUDE_, then capitals, digits and underscores',
      );
    }
    if (previous !== null && previous >= name) {
      throw refusal(subject, field, 'must follow ASCII order');
    }
    if (value.length > VALUE_CHARS || !PLAIN_VALUE.test(value)) {
      throw refusal(
        subject,
        field,
        `must be 1 to ${VALUE_CHARS} letters, digits, dots, dashes or underscores`,
      );
    }
    if (outer !== null && Object.hasOwn(outer, name)) {
      throw refusal(subject, field, 'must not name a variable env already sets');
    }
    previous = name;
  }
}

/** Is `tool` one the tool-approval table reads by the web ceiling (M57.7),
 * as subagents.rs's `held_by_the_web_switch`? No other CLI tool may ride with
 * a preset: the shell and the subagent tool write nothing a manifest row
 * records, yet act. */
function heldByTheWebSwitch(tool: CliTool): boolean {
  return TOOL_APPROVAL.families.find((row) => row.id === tool.family)?.ceiling === WEB_AXIS;
}

/** Does every row of `toolset` read, on a door that writes nothing? The
 * generated proposals' toolset never does: its tools propose changes. */
function readsOnly(manifest: ToolsManifest, toolset: string): boolean {
  const rows = manifest.tools.filter((row) => row.toolset === toolset);
  return (
    rows.length > 0 &&
    toolset !== manifest.generated.toolset &&
    rows.every(
      (row) =>
        row.kind === 'read_only' &&
        manifest.doors.find((door) => door.id === row.door)?.writes === false,
    )
  );
}

/** One preset (M91.2a), as subagents.rs's `check_preset`. */
function checkPreset(table: Subagents, at: number, preset: Preset, manifest: ToolsManifest): void {
  const subject = `preset ${JSON.stringify(preset.name)}`;
  if (!isAgentType(preset.name)) {
    throw refusal(
      subject,
      'name',
      'must be one or more letters, digits, colons, dots, dashes or underscores',
    );
  }
  if (table.presets.slice(0, at).some((earlier) => earlier.name === preset.name)) {
    throw refusal(subject, 'name', 'is named twice');
  }
  if (!isSentence(preset.description)) {
    throw refusal(
      subject,
      'description',
      `must be one sentence on one line: a capital letter first, a full stop last, at most ${DESCRIPTION_CHARS} characters`,
    );
  }
  if (preset.toolsets.length === 0) {
    throw refusal(subject, 'toolsets', 'must name at least one toolset');
  }
  preset.toolsets.forEach((id, i) => {
    const quoted = JSON.stringify(id);
    const problem = !manifest.toolsets.some((set) => set.id === id)
      ? `names no declared toolset: ${quoted}`
      : preset.toolsets.slice(0, i).includes(id)
        ? `repeats toolset ${quoted}`
        : !readsOnly(manifest, id)
          ? `must name toolsets of read_only rows on non-writing doors, not ${quoted}`
          : null;
    if (problem !== null) throw refusal(subject, 'toolsets', problem);
  });
  preset.web_when_held.forEach((name, i) => {
    const quoted = JSON.stringify(name);
    const tool = manifest.cli_tools.find((row) => row.name === name);
    const problem =
      tool === undefined
        ? `names no CLI tool in the manifest: ${quoted}`
        : preset.web_when_held.slice(0, i).includes(name)
          ? `repeats ${quoted}`
          : !heldByTheWebSwitch(tool)
            ? `names a CLI tool the web switch does not hold: ${quoted}`
            : null;
    if (problem !== null) throw refusal(subject, 'web_when_held', problem);
  });
}

/** Every refusal subagents.rs's `validate` makes, in its words. */
function validate(table: Subagents, manifest: ToolsManifest): void {
  if (table.format !== FORMAT) throw refusal('table', 'format', `must be ${FORMAT}`);
  if (!VERSION.test(table.cli_version)) throw refusal('table', 'cli_version', 'must be N.N.N');
  checkVariables('env', table.env, null);
  checkVariables('seated_env', table.seated_env, table.env);
  table.presets.forEach((preset, at) => checkPreset(table, at, preset, manifest));
  for (const [field, value] of [
    [
      'permissions.disableBypassPermissionsMode',
      table.settings.permissions.disableBypassPermissionsMode,
    ],
    ['disableAutoMode', table.settings.disableAutoMode],
  ] as const) {
    if (value !== DISABLE) throw refusal('settings', field, `must be ${DISABLE}`);
  }
}

/** Parse and fully validate an artifact against `manifest`. */
export function parseSubagents(value: unknown, manifest: ToolsManifest = TOOLS): Subagents {
  const table = checkShape(value);
  validate(table, manifest);
  return table;
}

/** The artifact's bytes, as vite imported them. */
export const SUBAGENTS_RAW: string = raw;

/** The shipped artifact, validated once at module load. */
export const SUBAGENTS: Subagents = parseSubagents(JSON.parse(raw));
