import { describe, expect, it } from 'vitest';
import TOOL_GRANTS from '../../src-tauri/fixtures/tool-grants.json';
import { agentFacingOps, POLICY } from '@/lib/policy/table';
import { TOOLS } from '@/lib/policy/tools';
import { parseShellCeiling, parseWebCeiling } from '@/lib/policy/toolApproval';
import {
  cliGrant,
  editsNotes,
  grantedTools,
  holds,
  holdsShell,
  holdsWeb,
  mentionedTools,
  namesTool,
  NOTE_EDITORS,
  type PromptGrant,
} from './toolGrant';

const sorted = (names: Iterable<string>) => [...names].sort();

/**
 * M54.7 — the TS half of Rust's `narrow`. Both languages replay the same
 * cases (granted_tools_match_the_shared_cases in src-tauri/src/agent/mod.rs),
 * so a declared name the CLI is granted is a name the prompt may use, and one
 * it is refused is a name the prompt never says.
 */
describe('grantedTools replays src-tauri/fixtures/tool-grants.json', () => {
  it('agrees with Rust on every case', () => {
    const all = sorted(grantedTools(null));
    expect(TOOL_GRANTS.cases.length).toBeGreaterThan(0);
    for (const { allowed_tools: declared, granted } of TOOL_GRANTS.cases) {
      expect(sorted(grantedTools(declared)), JSON.stringify(declared)).toEqual(
        granted === 'all' ? all : granted,
      );
    }
  });

  it('holds every base row a picker offers, and nothing else, when nothing narrows', () => {
    // The same set the Rust replay checks its own `all` against.
    const offered = TOOLS.tools
      .filter((row) => row.surface === 'base' && row.toolset !== null)
      .map((row) => row.name);
    expect(sorted(grantedTools(null))).toEqual(sorted(offered));
  });

  it('never holds a generated proposal tool, a window or an answer tool', () => {
    // TS cannot read the proposal switch, so it fails closed.
    const generated = agentFacingOps(POLICY).map((op) => `${TOOLS.generated.prefix}${op}`);
    const never = [...generated, 'commit_proposals', 'report_window_outcome', 'submit_answer'];
    expect(sorted(grantedTools(never))).toEqual([]);
    const all = grantedTools(null);
    for (const name of never) expect(all.has(name), name).toBe(false);
  });
});

/**
 * M57.2 — the CLI's own tools, by the tool-approval table, against the same
 * cases cli_grants_match_the_shared_cases replays in Rust: the ceiling
 * dimension.
 */
describe('cliGrant replays tool-grants.json cli_cases', () => {
  it('agrees with Rust on every case', () => {
    expect(TOOL_GRANTS.cli_cases.length).toBeGreaterThan(0);
    for (const c of TOOL_GRANTS.cli_cases) {
      const got = cliGrant({
        shell: parseShellCeiling(c.shell),
        web: parseWebCeiling('web' in c ? c.web : undefined),
        attended: c.kind === 'attended',
        readScoped: c.read_scoped,
        narrowing: c.allowed_tools,
      });
      expect(got, JSON.stringify(c)).toEqual({ cli: c.cli, asks: c.asks });
    }
  });

  it('holds the shell under On and Ask attended, and never for an unattended Ask run', () => {
    const at = (shell: 'off' | 'ask' | 'on', attended: boolean) =>
      holdsShell({ shell, attended, readScoped: false, narrowing: null });
    expect(at('off', true)).toBe(false);
    expect(at('ask', true)).toBe(true);
    expect(at('on', true)).toBe(true);
    expect(at('ask', false)).toBe(false);
    expect(at('on', false)).toBe(true);
    // A read limit withdraws it at every ceiling.
    for (const shell of ['off', 'ask', 'on'] as const) {
      expect(holdsShell({ shell, attended: true, readScoped: true, narrowing: null })).toBe(false);
    }
    // A record that names only cerebro's tools holds no CLI tool of its own.
    expect(
      holdsShell({ shell: 'on', attended: true, readScoped: false, narrowing: ['get_note'] }),
    ).toBe(false);
  });

  it('holds the web only under Web access On, and only the web tool a record names (M57.7)', () => {
    const at = (web: 'off' | 'on' | undefined, narrowing: string[] | null = null) =>
      holdsWeb({ shell: 'off', web, attended: true, readScoped: false, narrowing });
    expect(at(undefined)).toBe(false);
    expect(at('off')).toBe(false);
    expect(at('on')).toBe(true);
    expect(at('on', ['WebFetch'])).toBe(true);
    expect(at('on', ['WebSearch'])).toBe(false);
    expect(at('on', ['get_note'])).toBe(false);
    // Unattended too, and a read limit leaves it alone.
    expect(
      holdsWeb({ shell: 'on', web: 'on', attended: false, readScoped: true, narrowing: null }),
    ).toBe(true);
    // The web changes nothing, so it never counts as the shell.
    expect(
      holdsShell({ shell: 'off', web: 'on', attended: true, readScoped: false, narrowing: null }),
    ).toBe(false);
  });

  it('hears a name as names_tool does', () => {
    expect(namesTool(' bash ', 'Bash')).toBe(true);
    expect(namesTool('mcp__cerebro__get_note', 'mcp__cerebro__get_note')).toBe(true);
    expect(namesTool('get_note', 'mcp__cerebro__get_note')).toBe(true);
    expect(namesTool('mcp__cerebro__bash', 'Bash')).toBe(false);
    expect(namesTool('', 'Bash')).toBe(false);
  });
});

describe('holds and editsNotes', () => {
  const grant = (tools: string[], shell = false): PromptGrant => ({
    tools: new Set(tools),
    shell,
    attended: true,
  });

  it('holds only when every name is held', () => {
    expect(holds(grant(['get_note', 'search_notes']), 'get_note', 'search_notes')).toBe(true);
    expect(holds(grant(['get_note']), 'get_note', 'search_notes')).toBe(false);
    expect(holds(grant([]))).toBe(true);
  });

  it('reads the note editors off the manifest', () => {
    expect(sorted(NOTE_EDITORS)).toEqual([
      'append_to_note',
      'edit_note',
      'set_fields',
      'update_frontmatter',
    ]);
  });

  it('edits notes through a note editor or the shell, and through nothing else', () => {
    expect(editsNotes(grant(['update_frontmatter']))).toBe(true);
    expect(editsNotes(grant([], true))).toBe(true);
    // create_note makes a new note and edits none; write_concept writes the bundle.
    expect(editsNotes(grant(['create_note', 'write_concept', 'get_note']))).toBe(false);
  });
});

describe('mentionedTools', () => {
  it('finds bare and mcp__cerebro__-prefixed names', () => {
    expect(mentionedTools('read it with get_note, then search_notes.')).toEqual([
      'get_note',
      'search_notes',
    ]);
    expect(mentionedTools('call mcp__cerebro__open_note now')).toEqual(['open_note']);
    expect(mentionedTools('`mcp__cerebro__write_concept`')).toEqual(['write_concept']);
  });

  it('ignores names that only contain a tool name', () => {
    expect(mentionedTools('get_notes and xget_note and get_note_x')).toEqual([]);
    expect(mentionedTools('mcp__other__get_notes')).toEqual([]);
  });

  it('counts navigate only in backticks', () => {
    expect(mentionedTools('navigate the vault and get oriented')).toEqual([]);
    expect(mentionedTools('call `navigate` to move the app')).toEqual(['navigate']);
    expect(mentionedTools('or `mcp__cerebro__navigate`')).toEqual(['navigate']);
  });

  it('tells propose_organize apart from the generated propose_ names', () => {
    const generated = agentFacingOps(POLICY).map((op) => `${TOOLS.generated.prefix}${op}`);
    expect(generated).toContain('propose_cache_source');
    expect(mentionedTools('use propose_organize so the user can accept it')).toEqual([
      'propose_organize',
    ]);
    expect(mentionedTools('call propose_cache_source')).toEqual(['propose_cache_source']);
    expect(mentionedTools('then cache_source')).toEqual(['cache_source']);
  });
});
