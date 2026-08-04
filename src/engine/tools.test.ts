import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_TOOLS, matchedToolset, TOOLSETS, unknownTools, writesAnything } from './tools';

/**
 * M18.4 — the catalog is a MIRROR, and this is what keeps it one.
 *
 * `src-tauri/src/mcp.rs` serves the tools and enforces the narrowing; this
 * module only exists so a person can pick from a list instead of typing
 * thirteen identifiers from memory. A mirror that drifts is worse than no
 * mirror: the picker would offer a tool the server does not have, and the
 * resulting `allowed-tools:` would narrow a run to nothing while looking
 * deliberate.
 *
 * Same discipline the mock backend already carries for the Rust write guards.
 */
const RUST = readFileSync(resolve(process.cwd(), 'src-tauri/src/mcp.rs'), 'utf8');

/** Names in the `tool_catalog()` vec, in source order. */
function rustToolNames(): string[] {
  const start = RUST.indexOf('fn tool_catalog()');
  expect(start).toBeGreaterThan(-1);
  const body = RUST.slice(start);
  const end = body.indexOf('\n}\n');
  return [...body.slice(0, end).matchAll(/"name":\s*"([a-z_]+)"/g)].map((m) => m[1]);
}

describe('the tool catalog mirrors Rust', () => {
  it('offers exactly the tools the server serves', () => {
    expect([...ALL_TOOLS.map((t) => t.name)].sort()).toEqual([...rustToolNames()].sort());
  });

  it('names every tool once — a duplicate would double a checkbox', () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every tool a summary a person can read', () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.summary.length).toBeGreaterThan(10);
      expect(tool.summary).not.toBe(tool.name);
    }
  });
});

describe('toolsets', () => {
  it('puts every writing tool in a set whose hint says so', () => {
    // The grouping axis is "what can this change", so a tool that writes must
    // never be reachable by ticking a group that reads as harmless.
    const readOnly = TOOLSETS.find((s) => s.id === 'read');
    expect(readOnly?.tools.every((t) => !t.writes)).toBe(true);
  });

  it('recognises a selection that is exactly one set', () => {
    const read = TOOLSETS[0];
    expect(matchedToolset(read.tools.map((t) => t.name))?.id).toBe('read');
    expect(matchedToolset([read.tools[0].name])).toBe(null);
    expect(matchedToolset([])).toBe(null);
  });
});

describe('unknownTools', () => {
  it('surfaces a name the app does not recognise instead of dropping it', () => {
    // Dropping one would silently rewrite the user's policy on the next save —
    // and a hand-edited `allowed-tools:` is exactly the case where the app
    // should say "I do not know this" rather than quietly disagree.
    expect(unknownTools(['get_note', 'delete_everything'])).toEqual(['delete_everything']);
    expect(unknownTools(['get_note'])).toEqual([]);
  });
});

describe('writesAnything', () => {
  it('answers the one question a tool picker owes the person using it', () => {
    expect(writesAnything(['get_note', 'search_notes'])).toBe(false);
    expect(writesAnything(['get_note', 'create_note'])).toBe(true);
    expect(writesAnything([])).toBe(false);
  });
});
