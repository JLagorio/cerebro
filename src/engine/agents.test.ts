import { describe, expect, it } from 'vitest';
import { agentRef, listAgents } from './agents';
import { makeEntry } from './testHelpers';

const agent = (title: string, patch: Parameters<typeof makeEntry>[0] = {}) =>
  makeEntry({
    path: `records/agents/${title.toLowerCase().replace(/\s+/g, '-')}.md`,
    title,
    type: 'Agent',
    properties: { description: `${title} watches things.`, tools: 'safe' },
    ...patch,
  });

describe('listAgents', () => {
  it('lists Agent records with a process identity', () => {
    const refs = listAgents([
      agent('Release scout'),
      makeEntry({ path: 'items/a.md', title: 'Not an agent', type: 'Work item' }),
    ]);
    expect(refs).toHaveLength(1);
    expect(refs[0].actor).toBe('process:release-scout');
    expect(refs[0].shell).toBe(false);
  });

  it('reads shell intent and memory, defaulting both safe and empty', () => {
    const refs = listAgents([
      agent('Wide', { properties: { tools: 'shell', memory: 'knows a thing' } }),
      agent('Bare', { properties: {} }),
    ]);
    const wide = refs.find((r) => r.title === 'Wide');
    const bare = refs.find((r) => r.title === 'Bare');
    expect(wide?.shell).toBe(true);
    // M17.14 split memory into tiers; the pre-M17 flat `memory:` reads as the
    // agent's working notes so an existing vault forgets nothing.
    expect(wide?.memory.recent).toBe('knows a thing');
    expect(bare?.shell).toBe(false);
    expect(bare?.memory).toEqual({ recent: '', preferences: '' });
  });

  it('skips unparseable records', () => {
    expect(listAgents([agent('Broken', { parseError: 'bad yaml' })])).toEqual([]);
  });
});

/**
 * M17.13 — scope, and M17.8's identity applied to agents.
 *
 * The parse is the app's half; the refusal is in Rust (mcp.rs RunGrant), which
 * is the point: an agent cannot be talked out of a folder boundary the way it
 * can be talked out of a sentence in its instructions.
 */
describe('agent scope', () => {
  const agent = (properties: Record<string, unknown>) =>
    makeEntry({
      path: 'records/agents/scout.md',
      title: 'Release scout',
      type: 'Agent',
      properties: properties as never,
    });

  it('is null when undeclared, which is what every agent was before', () => {
    expect(agentRef(agent({})).scope).toBeNull();
  });

  it('reads one folder or a list of them', () => {
    expect(agentRef(agent({ scope: 'projects/atlas' })).scope).toEqual(['projects/atlas']);
    expect(agentRef(agent({ scope: ['projects/atlas', 'inbox'] })).scope).toEqual([
      'projects/atlas',
      'inbox',
    ]);
  });

  it('normalizes the ways a person writes a folder', () => {
    expect(agentRef(agent({ scope: ['/projects/atlas/', './inbox'] })).scope).toEqual([
      'projects/atlas',
      'inbox',
    ]);
  });

  it('keeps an empty declaration EMPTY rather than reading it as everywhere', () => {
    // The dangerous case: `scope:` with nothing under it. Rust refuses every
    // write for an empty list, so this must not collapse to null.
    expect(agentRef(agent({ scope: [] })).scope).toEqual([]);
  });

  it('carries a tool narrowing the same way a skill does', () => {
    expect(agentRef(agent({ 'allowed-tools': 'search_notes, get_note' })).allowedTools).toEqual([
      'search_notes',
      'get_note',
    ]);
  });
});

describe('an agent’s identity survives a rename', () => {
  it('fixes the actor, so provenance does not split in two at the rename', () => {
    // The actor is stamped into `generated.by` on everything the agent writes.
    // Deriving it from the title meant renaming an agent silently
    // re-attributed everything it wrote from that moment on.
    const before = makeEntry({
      path: 'records/agents/scout.md',
      title: 'Release scout',
      type: 'Agent',
      properties: { slug: 'release-scout' } as never,
    });
    const after = makeEntry({
      path: 'records/agents/watcher.md',
      title: 'Ship watcher',
      type: 'Agent',
      properties: { slug: 'release-scout' } as never,
    });
    expect(agentRef(before).actor).toBe('process:release-scout');
    expect(agentRef(after).actor).toBe('process:release-scout');
    expect(agentRef(before).id).toBe(agentRef(after).id);
  });

  it('still derives from the title when nothing is declared', () => {
    const plain = makeEntry({
      path: 'records/agents/scout.md',
      title: 'Release scout',
      type: 'Agent',
    });
    expect(agentRef(plain).actor).toBe('process:release-scout');
  });
});

/**
 * M17.14 — memory tiers.
 *
 * Two fields, not three: "Intelligence" — what the agent inferred — is the
 * knowledge bundle, which already stores inferences with provenance and needs
 * a human stamp to become verified. A third frontmatter blob would be a
 * second, worse copy of what M8 built properly.
 */
describe('memory tiers', () => {
  const withProps = (properties: Record<string, unknown>) =>
    agentRef(
      makeEntry({
        path: 'records/agents/scout.md',
        title: 'Scout',
        type: 'Agent',
        properties: properties as never,
      }),
    );

  it('reads the agent’s working notes and the human’s corrections apart', () => {
    const memory = withProps({ recent: 'saw three risks', preferences: 'be terser' }).memory;
    expect(memory).toEqual({ recent: 'saw three risks', preferences: 'be terser' });
  });

  it('still reads a pre-M17.14 vault’s flat memory as working notes', () => {
    // A vault written against the old shape must not silently forget
    // everything its agents had learned.
    expect(withProps({ memory: 'old notes' }).memory.recent).toBe('old notes');
  });

  it('prefers the new key when a record carries both', () => {
    expect(withProps({ memory: 'old', recent: 'new' }).memory.recent).toBe('new');
  });

  it('is empty rather than absent on a first run', () => {
    expect(withProps({}).memory).toEqual({ recent: '', preferences: '' });
  });
});
