import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentFacingOps, POLICY } from '@/lib/policy/table';
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

/**
 * Names in the `base_tools()` vec, in source order.
 *
 * `base_tools` and not `tool_catalog` since M26.3c: the catalog now appends a
 * half GENERATED from the policy artifact, which carries no `"name": "literal"`
 * for a source scrape to find. Scraping the whole catalog would silently see
 * only the hand-written twelve and call the mirror complete.
 */
function rustToolNames(): string[] {
  const start = RUST.indexOf('fn base_tools()');
  expect(start).toBeGreaterThan(-1);
  const body = RUST.slice(start);
  const end = body.indexOf('\n}\n');
  return [...body.slice(0, end).matchAll(/"name":\s*"([a-z_]+)"/g)].map((m) => m[1]);
}

/** The proposal half, derived from the shared artifact — the same source the
 * Rust server generates its half from. */
function expectedProposalTools(): string[] {
  return [...agentFacingOps(POLICY).map((op) => `propose_${op}`), 'commit_proposals'].sort();
}

describe('the tool catalog mirrors Rust', () => {
  it('offers exactly the hand-written tools the server serves', () => {
    // The scrape target is `base_tools()` now: the proposal half has no
    // `"name": "literal"` in the source to find, because it is generated.
    const generated = new Set(expectedProposalTools());
    const handWritten = ALL_TOOLS.map((t) => t.name).filter((n) => !generated.has(n));
    expect([...handWritten].sort()).toEqual([...rustToolNames()].sort());
  });

  it('names every tool once — a duplicate would double a checkbox', () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('offers exactly the proposal surface the policy artifact authorises', () => {
    // **THE INVERTED ASSERTION** (M26.3c). Until this phase it proved the
    // proposal surface was ABSENT, and that absence was the guarantee. The
    // guarantee moved rather than disappeared: what is asserted now is that
    // the picker offers exactly what the shared artifact authorises — the
    // same set `policy::submit`'s tripwire holds the live server to, derived
    // from the same bytes on both sides.
    const names = ALL_TOOLS.map((t) => t.name);
    for (const name of expectedProposalTools()) {
      expect(names, `${name} is authorised and not offered`).toContain(name);
    }

    // A synonym is a second way to say the same thing, and the second way is
    // the one nothing governs. `record_decision` would let a run approve its
    // own queued cards.
    for (const forbidden of [
      'submit_proposal',
      'propose_mutation',
      'record_decision',
      'resolve_commit_set',
    ]) {
      expect(names).not.toContain(forbidden);
    }

    // `revert_proposal` is withheld by the ARTIFACT (`agent_facing: false`),
    // not by this list: it is MEDIUM, MEDIUM auto-applies, and an
    // agent-facing revert would undo an applied mutation — including one a
    // human just approved on a HIGH card — with no second card to notice.
    expect(names).not.toContain('propose_revert_proposal');
    expect(POLICY.ops.revert_proposal.agent_facing).toBe(false);
  });

  it('never lets a proposal tool read as harmless', () => {
    // The grouping axis is "what can this change". 12 of the 20 ops are LOW
    // or MEDIUM and AUTO-APPLY once committed, so a proposal tool in a group
    // that read as read-only would be a lie for exactly the ops most likely
    // to be picked.
    for (const name of expectedProposalTools()) {
      expect(writesAnything([name]), `${name}`).toBe(true);
    }
    const readOnly = TOOLSETS.find((s) => s.id === 'read');
    expect(readOnly?.tools.some((t) => expectedProposalTools().includes(t.name))).toBe(false);
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
