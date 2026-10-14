/**
 * The tool manifest, TS side (M54.2) — byte identity with Rust, the same
 * strict load refusals, and the facts the app's surfaces read.
 *
 * @see src-tauri/src/policy/tools.rs
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { sha256Hex } from '../sha256';
import { POLICY } from './table';
import {
  bareToolName,
  parseToolsManifest,
  TOOLS,
  TOOLS_DIGEST_PATH,
  TOOLS_FORMAT,
  TOOLS_PATH,
  toolFacts,
  type CliTool,
  type ToolRow,
  type ToolsManifest,
} from './tools';

const REPO = join(__dirname, '../../..');
const RAW = readFileSync(join(REPO, TOOLS_PATH), 'utf8');

describe('the shared manifest is one artifact', () => {
  it('hashes to the digest the Rust core also asserts', () => {
    // The cross-language anchor, as for the policy table: Rust hashes what
    // `include_str!` compiled in against this same file. Regenerate it
    // deliberately after a manifest edit with
    // `cargo test --lib policy::tools::tests::write_tools_digest -- --ignored`.
    const committed = readFileSync(join(REPO, TOOLS_DIGEST_PATH), 'utf8').trim();
    expect(sha256Hex(RAW)).toBe(committed);
  });

  it('is the same object vite imported, not a copy in src/', () => {
    expect(JSON.parse(RAW)).toEqual(TOOLS);
  });

  it('validates on load', () => {
    expect(TOOLS.format).toBe(TOOLS_FORMAT);
    expect(TOOLS.tools.length).toBeGreaterThan(0);
    expect(TOOLS.cli_tools.length).toBeGreaterThan(0);
  });
});

// --- What the load refuses ---------------------------------------------------
//
// One negative control per refusal, the same list as tools.rs: each mutates a
// copy of the shipped bytes, and each message names what it refused and the
// field, in the words the Rust loader uses.

/** Sets a field the manifest's types do not allow, for the shape cases. */
function put(target: object, key: string, value: unknown): void {
  (target as Record<string, unknown>)[key] = value;
}

/** Removes a field the manifest's types require. */
function drop(target: object, key: string): void {
  delete (target as Record<string, unknown>)[key];
}

/** What a mutated copy of the shipped manifest is refused with. */
function refused(mutate: (raw: ToolsManifest) => void): string {
  const raw = JSON.parse(RAW) as ToolsManifest;
  mutate(raw);
  try {
    parseToolsManifest(raw);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('the mutated manifest must not load');
}

function tool(raw: ToolsManifest, name: string): ToolRow {
  const row = raw.tools.find((r) => r.name === name);
  if (row === undefined) throw new Error(`the manifest has a ${name} row`);
  return row;
}

function cli(raw: ToolsManifest, name: string): CliTool {
  const row = raw.cli_tools.find((r) => r.name === name);
  if (row === undefined) throw new Error(`the manifest has a ${name} CLI row`);
  return row;
}

/** A row's input schema, as the cases edit it. */
interface Schema {
  type: string;
  properties: Record<string, Record<string, unknown>>;
  required: string[];
}

function schema(row: ToolRow): Schema {
  return row.input_schema as Schema;
}

type Case = [label: string, mutate: (raw: ToolsManifest) => void, fragments: string[]];

function expectNames(cases: Case[]) {
  for (const [label, mutate, fragments] of cases) {
    const message = refused(mutate);
    for (const fragment of fragments) {
      expect(message, `${label}: ${fragment}`).toContain(fragment);
    }
  }
}

describe('the load refuses what tools.rs refuses, in the same words', () => {
  it('names the field at the manifest level', () => {
    expectNames([
      ['format', (v) => (v.format = 2), ['manifest', '`format`']],
      ['artifact_version', (v) => (v.artifact_version = 0), ['manifest', '`artifact_version`']],
      ['rule_version', (v) => (v.rule_version = ' '), ['manifest', '`rule_version`']],
      ['server', (v) => (v.server = 'cere__bro'), ['manifest', '`server`']],
      ['door twice', (v) => v.doors.push(v.doors[0]), ['door none', '`id`', 'twice']],
      ['toolset twice', (v) => v.toolsets.push(v.toolsets[0]), ['toolset read', '`id`', 'twice']],
      [
        'tool twice',
        (v) => v.tools.push(v.tools[0]),
        ['tool get_vault_context', '`name`', 'twice'],
      ],
      [
        'cli tool twice',
        (v) => v.cli_tools.push(v.cli_tools[0]),
        ['cli tool Write', '`name`', 'twice'],
      ],
      [
        'read_only on a writing door',
        (v) => v.doors[1].kinds.push('read_only'),
        ['door note', '`kinds`', 'read_only'],
      ],
      [
        'unused toolset',
        (v) => v.toolsets.push({ id: 'spare', label: 'Spare', hint: 'Holds nothing.' }),
        ['toolset spare', '`id`', 'no tool'],
      ],
    ]);
  });

  it('names the row and the field', () => {
    expectNames([
      [
        'name shape',
        (v) => (tool(v, 'get_note').name = 'Get_note'),
        ['tool Get_note', '`name`', '[a-z][a-z_]*'],
      ],
      [
        'name length',
        (v) => (tool(v, 'get_note').name = 'get_note_'.repeat(6)),
        ['tool get_note_get_note_', '`name`', 'over 64'],
      ],
      ['empty title', (v) => (tool(v, 'get_note').title = ''), ['tool get_note', '`title`']],
      [
        'long title',
        (v) => (tool(v, 'get_note').title = 't'.repeat(65)),
        ['tool get_note', '`title`'],
      ],
      [
        'short summary',
        (v) => (tool(v, 'get_note').summary = 'Read it'),
        ['tool get_note', '`summary`'],
      ],
      [
        'summary is the name',
        (v) => (tool(v, 'search_notes').summary = 'search_notes'),
        ['tool search_notes', '`summary`'],
      ],
      [
        'undeclared toolset',
        (v) => (tool(v, 'get_note').toolset = 'reading'),
        ['tool get_note', '`toolset`', 'names reading'],
      ],
      [
        'undeclared door',
        (v) => (tool(v, 'get_note').door = 'window'),
        ['tool get_note', '`door`', 'names window'],
      ],
      [
        'kind the door forbids',
        (v) => (tool(v, 'write_concept').kind = 'additive'),
        ['tool write_concept', '`kind`', 'door concept allows'],
      ],
      [
        'read_only not idempotent',
        (v) => (tool(v, 'get_note').idempotent = false),
        ['tool get_note', '`idempotent`', 'read_only'],
      ],
      [
        'axis the door forbids',
        (v) => (tool(v, 'hand_to').axis = 'write'),
        ['tool hand_to', '`axis`', 'door run allows'],
      ],
      [
        'read_write on a door without it',
        (v) => (tool(v, 'get_note').axis = 'read_write'),
        ['tool get_note', '`axis`', 'read_write', 'door none allows'],
      ],
    ]);
  });

  it('names the row and the field for a target', () => {
    expectNames([
      [
        'write axis without a target',
        (v) => (tool(v, 'create_note').target = null),
        ['tool create_note', '`target`', 'write axis'],
      ],
      [
        'write axis aimed at a concept',
        (v) => (tool(v, 'create_note').target!.kind = 'concept'),
        ['tool create_note', '`target`', 'write axis'],
      ],
      [
        'read axis aimed at a concept',
        (v) => (tool(v, 'get_note').target!.kind = 'concept'),
        ['tool get_note', '`target`', 'read axis'],
      ],
      [
        'read_write axis aimed at a folder',
        (v) => (tool(v, 'edit_note').target!.kind = 'folder'),
        ['tool edit_note', '`target`', 'read_write axis'],
      ],
      [
        'argument the schema lacks',
        (v) => (tool(v, 'get_note').target!.arg = 'note_path'),
        ['tool get_note', '`target`', 'names note_path'],
      ],
      [
        'argument the schema does not require',
        (v) => (schema(tool(v, 'create_note')).required = ['slug', 'body']),
        ['tool create_note', '`target`', 'names folder'],
      ],
      [
        'bundle with an argument',
        (v) => (tool(v, 'knowledge_about').target!.arg = 'target'),
        ['tool knowledge_about', '`target`', 'bundle'],
      ],
      [
        'source_id without an argument',
        (v) => (tool(v, 'cache_source').target!.arg = null),
        ['tool cache_source', '`target`', 'source_id'],
      ],
      [
        'axis none without exempt',
        (v) => (tool(v, 'navigate').exempt = null),
        ['tool navigate', '`exempt`'],
      ],
      [
        'axis none with a blank exempt',
        (v) => (tool(v, 'navigate').exempt = '  '),
        ['tool navigate', '`exempt`'],
      ],
      [
        'exempt on a bound axis',
        (v) => (tool(v, 'search_notes').exempt = 'reads'),
        ['tool search_notes', '`exempt`', 'read axis'],
      ],
    ]);
  });

  it('names the row and the field for content', () => {
    expectNames([
      [
        'change card on a door that writes nothing',
        (v) => (tool(v, 'open_note').renderer = 'change'),
        ['tool open_note', '`renderer`', 'door that writes'],
      ],
      [
        'change card without a target',
        (v) => (tool(v, 'write_concept').target = null),
        ['tool write_concept', '`renderer`', 'target'],
      ],
      [
        'icon shape',
        (v) => (tool(v, 'get_note').icon = 'FileText'),
        ['tool get_note', '`icon`', 'FileText'],
      ],
      [
        'empty search hint',
        (v) => (tool(v, 'get_note').search_hint = ''),
        ['tool get_note', '`search_hint`'],
      ],
      [
        'long search hint',
        (v) => (tool(v, 'get_note').search_hint = 'w '.repeat(41)),
        ['tool get_note', '`search_hint`'],
      ],
      [
        'short description',
        (v) => (tool(v, 'get_note').description = 'Read a note.'),
        ['tool get_note', '`description`', '12'],
      ],
      [
        'long description',
        (v) => (tool(v, 'get_note').description = 'd'.repeat(2049)),
        ['tool get_note', '`description`', '2049'],
      ],
      [
        'schema root not an object',
        (v) => (schema(tool(v, 'get_note')).type = 'array'),
        ['tool get_note', '`input_schema`', 'object'],
      ],
      [
        'schema requires what it lacks',
        (v) => (schema(tool(v, 'get_note')).required = ['path', 'depth']),
        ['tool get_note', '`input_schema`', 'depth'],
      ],
      [
        'undeclared token in a description',
        (v) =>
          (tool(v, 'get_note').description = 'Read one note in full, typed as {{note_kinds}}.'),
        ['tool get_note', '`description`', '{{note_kinds}}'],
      ],
      [
        'undeclared token in a schema',
        (v) =>
          (schema(tool(v, 'get_note')).properties.path.description = 'A path under {{folders}}'),
        ['tool get_note', '`input_schema`', '{{folders}}'],
      ],
      [
        'unused token',
        (v) => (v.tokens.spare = { why: 'used by nothing' }),
        ['token spare', '`tokens`'],
      ],
      [
        'exception that names no row',
        (v) => v.prefix_exceptions.push({ name: 'propose_nothing', why: 'a row that is gone' }),
        ['prefix exception propose_nothing', '`name`'],
      ],
    ]);
  });

  it('refuses a hand-written propose_ name, and lists one exception', () => {
    // The generated namespace is the policy table's; a second hand-written
    // `propose_` tool would be a second door into it.
    expectNames([
      [
        'hand-written propose_',
        (v) => (tool(v, 'open_note').name = 'propose_open_note'),
        ['tool propose_open_note', '`name`', 'prefix_exceptions'],
      ],
    ]);
    expect(TOOLS.prefix_exceptions.map((e) => e.name)).toEqual(['propose_organize']);
  });

  it('holds the generated block to the row rules', () => {
    expectNames([
      [
        'empty title prefix',
        (v) => (v.generated.title_prefix = ''),
        ['generated', '`title_prefix`'],
      ],
      [
        'undeclared door',
        (v) => (v.generated.door = 'vault'),
        ['generated', '`door`', 'names vault'],
      ],
      ['no exempt', (v) => (v.generated.exempt = null), ['generated', '`exempt`']],
      [
        'change card without a target',
        (v) => (v.generated.renderer = 'change'),
        ['generated', '`renderer`', 'target'],
      ],
    ]);
  });

  it('names the CLI row and the field', () => {
    expectNames([
      [
        'name shape',
        (v) => (cli(v, 'Task').name = 'task'),
        ['cli tool task', '`name`', '[A-Z][A-Za-z]*'],
      ],
      [
        'shell grant nothing withdraws',
        (v) => (cli(v, 'Read').denied_when_read_scoped = false),
        ['cli tool Read', '`with_shell`'],
      ],
      [
        'denied twice',
        (v) => (cli(v, 'Bash').denied_when_read_scoped = true),
        ['cli tool Bash', '`denied_when_read_scoped`'],
      ],
      [
        'a writer shell-less runs keep',
        (v) => (cli(v, 'WebFetch').writes = true),
        ['cli tool WebFetch', '`denied_without_shell`'],
      ],
      [
        'change card on a reader',
        (v) => (cli(v, 'Grep').renderer = 'change'),
        ['cli tool Grep', '`renderer`'],
      ],
      ['icon shape', (v) => (cli(v, 'Grep').icon = 'search_icon'), ['cli tool Grep', '`icon`']],
    ]);
  });

  it('fails an unknown field rather than dropping it', () => {
    const message = refused((v) => put(tool(v, 'get_note'), 'readonly', true));
    expect(message).toContain(TOOLS_PATH);
    expect(message).toContain('readonly');
  });
});

describe('the shape serde holds the Rust side to', () => {
  // serde checks these before `validate` runs, so tools.rs needs no case for
  // them; here the shape is checked by hand, and these are its controls.

  it('fails a missing field, a wrong type and a word outside an enum, naming each', () => {
    expectNames([
      [
        'missing title',
        (v) => drop(tool(v, 'get_note'), 'title'),
        ['tool get_note', '`title`', 'missing'],
      ],
      [
        'string flag',
        (v) => put(tool(v, 'get_note'), 'idempotent', 'yes'),
        ['tool get_note', '`idempotent`', 'true or false'],
      ],
      [
        'unknown kind',
        (v) => put(tool(v, 'get_note'), 'kind', 'teleport'),
        ['tool get_note', '`kind`', 'read_only, additive, destructive'],
      ],
      [
        'unknown target field',
        (v) => put(tool(v, 'get_note').target!, 'via', 'path'),
        ['tool get_note', '`target.via`'],
      ],
      [
        'unknown generated field',
        (v) => put(v.generated, 'writes', true),
        ['generated', '`writes`'],
      ],
      ['format as text', (v) => put(v, 'format', '1'), ['manifest', '`format`', 'whole number']],
      ['doors not a list', (v) => put(v, 'doors', {}), ['manifest', '`doors`', 'list']],
      ['tokens not a map', (v) => put(v, 'tokens', []), ['manifest', '`tokens`', 'object']],
      [
        'a row with no name to give',
        (v) => put(v.tools[2], 'name', 7),
        ['tools[2]', '`name`', 'string'],
      ],
    ]);
    expect(() => parseToolsManifest([])).toThrow(`${TOOLS_PATH}: must be a JSON object`);
  });

  it('reads an absent Option field as null, as serde does', () => {
    const raw = JSON.parse(RAW) as ToolsManifest;
    drop(tool(raw, 'search_notes'), 'target');
    drop(tool(raw, 'search_notes'), 'exempt');
    const loaded = parseToolsManifest(raw);
    const row = loaded.tools.find((r) => r.name === 'search_notes');
    expect(row?.target).toBeNull();
    expect(row?.exempt).toBeNull();
  });
});

describe('toolFacts', () => {
  it('answers the short and the full spelling alike', () => {
    for (const name of ['get_note', 'create_note', 'commit_proposals', 'propose_create_belief']) {
      expect(toolFacts(name), name).not.toBeNull();
      expect(toolFacts(`mcp__${TOOLS.server}__${name}`), name).toEqual(toolFacts(name));
    }
    expect(bareToolName('mcp__cerebro__get_note')).toBe('get_note');
    expect(bareToolName('Bash')).toBe('Bash');
  });

  it('knows nothing of another server’s tool or a name it does not serve', () => {
    expect(toolFacts('mcp__other__get_note')).toBeNull();
    expect(bareToolName('mcp__other__get_note')).toBe('mcp__other__get_note');
    expect(toolFacts('delete_everything')).toBeNull();
    expect(toolFacts('Get_note')).toBeNull();
  });

  it('gives no facts to an op the policy table offers no agent', () => {
    // The prefix alone is not enough: revert_proposal carries
    // `agent_facing: false`, so `propose_revert_proposal` is no tool at all.
    expect(POLICY.ops.revert_proposal.agent_facing).toBe(false);
    expect(toolFacts('propose_revert_proposal')).toBeNull();
  });

  it('reads propose_organize as its own row, never as a generated tool', () => {
    expect(toolFacts('propose_organize')?.origin).toBe('row');
    expect(toolFacts('propose_create_belief')?.origin).toBe('generated');
  });

  it('says Bash does not write and MultiEdit does', () => {
    expect(toolFacts('Bash')).toMatchObject({ origin: 'cli', writes: false, renderer: 'step' });
    expect(toolFacts('MultiEdit')).toMatchObject({
      origin: 'cli',
      writes: true,
      renderer: 'change',
    });
  });

  it('carries a row’s target and its door’s writes flag', () => {
    expect(toolFacts('create_note')).toMatchObject({
      writes: true,
      target: { arg: 'folder', kind: 'folder' },
    });
    expect(toolFacts('get_note')).toMatchObject({
      writes: false,
      target: { arg: 'path', kind: 'note' },
    });
    expect(toolFacts('commit_proposals')).toMatchObject({ writes: true, target: null });
  });
});
