import { describe, expect, it } from 'vitest';
import TOOL_CASES from '../../src-tauri/fixtures/tool-cases.json';
import { agentFacingOps, POLICY } from '@/lib/policy/table';
import { TOOLS } from '@/lib/policy/tools';
import {
  ALL_TOOLS,
  holdsProposalTools,
  isWriteTool,
  matchedToolset,
  proposalConsequence,
  showsAsChange,
  toolFold,
  toolIconName,
  toolRenderer,
  TOOLSETS,
  unknownTools,
  writesAnything,
} from './tools';

/** The generated proposal tools, in policy order, named with the manifest's
 * prefix — the same source the Rust server generates its half from. */
function generatedNames(): string[] {
  return agentFacingOps(POLICY).map((op) => `${TOOLS.generated.prefix}${op}`);
}

/** The proposal half: the generated tools, then the rows filed beside them. */
function expectedProposalTools(): string[] {
  return [...generatedNames(), 'commit_proposals'];
}

/** Does a call through this door change something on disk? */
function doorWrites(id: string): boolean {
  const door = TOOLS.doors.find((d) => d.id === id);
  if (door === undefined) throw new Error(`no door ${id}`);
  return door.writes;
}

describe('the picker reads the tool manifest (M54.2)', () => {
  it('lists every manifest row exactly once', () => {
    for (const row of TOOLS.tools) {
      expect(
        ALL_TOOLS.filter((t) => t.name === row.name),
        row.name,
      ).toHaveLength(1);
    }
  });

  it('keeps the manifest’s toolsets, in its order, and leaves none empty', () => {
    expect(TOOLSETS.map(({ id, label, hint }) => ({ id, label, hint }))).toEqual(TOOLS.toolsets);
    for (const set of TOOLSETS) expect(set.tools.length, set.id).toBeGreaterThan(0);
  });

  it('files each row under its own toolset, in served order, with its own summary', () => {
    const generated = new Set(generatedNames());
    for (const set of TOOLSETS) {
      const rows = TOOLS.tools.filter((row) => row.toolset === set.id);
      const handWritten = set.tools.filter((t) => !generated.has(t.name));
      expect(handWritten.map((t) => t.name)).toEqual(rows.map((row) => row.name));
      expect(handWritten.map((t) => t.summary)).toEqual(rows.map((row) => row.summary));
    }
  });

  it('leaves out of every picker exactly the rows with no toolset', () => {
    const picked = new Set(TOOLSETS.flatMap((set) => set.tools.map((t) => t.name)));
    const unpickable = ALL_TOOLS.filter((t) => !picked.has(t.name)).map((t) => t.name);
    expect(unpickable).toEqual(
      TOOLS.tools.filter((row) => row.toolset === null).map((row) => row.name),
    );
  });

  it('fills the proposal set with the generated tools in policy order, then commit_proposals', () => {
    const set = TOOLSETS.find((s) => s.id === TOOLS.generated.toolset);
    expect(set?.tools.map((t) => t.name)).toEqual(expectedProposalTools());
  });

  it('takes each writes flag from the tool’s door', () => {
    const generated = new Set(generatedNames());
    for (const tool of ALL_TOOLS) {
      const row = TOOLS.tools.find((r) => r.name === tool.name);
      const door = generated.has(tool.name) ? TOOLS.generated.door : row?.door;
      expect(door, tool.name).toBeDefined();
      expect(tool.writes, tool.name).toBe(doorWrites(door ?? ''));
    }
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

describe('the read toolset (M59.5)', () => {
  it('is the six readers, list_notes after search_notes, none writing', () => {
    const read = TOOLSETS.find((s) => s.id === 'read');
    expect(read?.label).toBe('Read the vault');
    expect(read?.tools.map((t) => t.name)).toEqual([
      'get_vault_context',
      'search_notes',
      'list_notes',
      'get_note',
      'knowledge_about',
      'list_inbox',
    ]);
    expect(read?.tools.some((t) => t.writes)).toBe(false);
  });
});

describe('the write toolset', () => {
  it('is create_note, update_frontmatter, set_fields, append_to_note and edit_note, in that order, all writing', () => {
    const write = TOOLSETS.find((s) => s.id === 'write');
    expect(write?.tools.map((t) => t.name)).toEqual([
      'create_note',
      'update_frontmatter',
      'set_fields',
      'append_to_note',
      'edit_note',
    ]);
    expect(write?.tools.every((t) => t.writes)).toBe(true);
  });
});

describe('the comment toolset (M70.3)', () => {
  it('sits right after write and holds the three comment tools in order, writing nothing', () => {
    const ids = TOOLSETS.map((s) => s.id);
    expect(ids.indexOf('comment')).toBe(ids.indexOf('write') + 1);
    const comment = TOOLSETS.find((s) => s.id === 'comment');
    expect(comment?.label).toBe('Comment on pages');
    expect(comment?.tools.map((t) => t.name)).toEqual([
      'comment_on_note',
      'reply_to_comment',
      'resolve_comment',
    ]);
    // A comment changes no page: no rescan, no checkpoint, no written path.
    expect(comment?.tools.some((t) => t.writes)).toBe(false);
    for (const name of ['comment_on_note', 'mcp__cerebro__reply_to_comment', 'resolve_comment']) {
      expect(isWriteTool(name), name).toBe(false);
      expect(showsAsChange(name), name).toBe(false);
    }
  });
});

describe('isWriteTool', () => {
  // The shared cases are Rust's `writes_disk`, replayed here from the same
  // bytes, so the turn checkpoint and the server cannot disagree about which
  // calls write.
  it.each(TOOL_CASES.cases.map((c) => [c.tool, c.writes_disk] as const))(
    'replays shared case %# for %s: writes %s',
    (tool, writes) => {
      expect(isWriteTool(tool)).toBe(writes);
    },
  );
});

describe('showsAsChange and toolIconName', () => {
  it('draws a change card only where the manifest says so', () => {
    expect(showsAsChange('mcp__cerebro__append_to_note')).toBe(true);
    expect(showsAsChange('Write')).toBe(true);
    expect(showsAsChange('mcp__cerebro__propose_organize')).toBe(false);
    expect(showsAsChange('mcp__gmail__send')).toBe(false);
  });

  it('falls back to the wrench only for a tool the manifest does not know', () => {
    expect(toolIconName('mcp__cerebro__hand_to')).toBe('forward');
    expect(toolIconName('Task')).toBe('bot');
    expect(toolIconName('mcp__gmail__send')).toBe('wrench');
  });
});

describe('toolRenderer and toolFold (M56.8)', () => {
  // The shared cases are Rust's `renderer` and `fold`, replayed here from the
  // same bytes, so a row the panel draws and the one Rust names agree.
  it.each(TOOL_CASES.cases.map((c) => [c.tool, c.renderer, c.fold] as const))(
    'replays shared case %# for %s: %s',
    (tool, renderer, fold) => {
      expect(toolRenderer(tool)).toBe(renderer);
      expect(toolFold(tool)).toEqual(fold);
    },
  );

  it('names the rows a cerebro tool owns', () => {
    expect(toolRenderer('mcp__cerebro__write_concept')).toBe('concept');
    expect(toolRenderer('mcp__cerebro__recheck_concept')).toBe('concept');
    expect(toolRenderer('mcp__cerebro__hand_to')).toBe('handoff');
    expect(toolRenderer('mcp__cerebro__commit_proposals')).toBe('commit');
    expect(toolRenderer('mcp__cerebro__propose_create_belief')).toBe('step');
  });

  it('folds a read, never a write, and reads a connector tool as a step that never folds', () => {
    expect(toolFold('mcp__cerebro__get_note')).toEqual({
      one: 'read a note',
      many: 'read {n} notes',
    });
    expect(toolFold('Grep')?.many).toBe('searched files {n} times');
    expect(toolFold('mcp__cerebro__create_note')).toBeNull();
    expect(toolRenderer('mcp__gmail__search')).toBe('step');
    expect(toolFold('mcp__gmail__search')).toBeNull();
  });

  it('keeps a concept a change card, its path in view', () => {
    expect(showsAsChange('mcp__cerebro__write_concept')).toBe(true);
    expect(showsAsChange('mcp__cerebro__commit_proposals')).toBe(false);
    expect(showsAsChange('mcp__cerebro__hand_to')).toBe(false);
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

describe('proposal consequence (M36.5)', () => {
  it('the counts are the artifact, partitioned — never a second inventory', () => {
    const { applies, queues } = proposalConsequence();
    const ops = agentFacingOps(POLICY);
    expect(applies + queues).toBe(ops.length);
    expect(queues).toBe(ops.filter((op) => POLICY.ops[op].base_risk === 'HIGH').length);
    // Both sides are non-empty in the shipped table — a table where either
    // was zero would make one of the consequence sentences a lie.
    expect(applies).toBeGreaterThan(0);
    expect(queues).toBeGreaterThan(0);
  });

  it('the table renders for armed agents only', () => {
    expect(holdsProposalTools(null)).toBe(false);
    expect(holdsProposalTools(['get_note', 'write_concept'])).toBe(false);
    expect(holdsProposalTools(['propose_organize'])).toBe(false);
    expect(holdsProposalTools(['commit_proposals'])).toBe(true);
    expect(holdsProposalTools([`propose_${agentFacingOps(POLICY)[0]}`])).toBe(true);
  });
});
