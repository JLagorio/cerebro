import { describe, expect, it } from 'vitest';
import { TOOL_APPROVAL } from '@/lib/policy/toolApproval';
import {
  agentRef,
  askFirstOf,
  isPaused,
  linkedTiers,
  listAgents,
  narrowTools,
  readAddress,
} from './agents';
import { isPaused as reexported } from './jobs';
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

  // M57.7: `tools:` takes shell, web or both, as a word or a list, and
  // anything else declares nothing.
  it('reads the host grants tools: declares', () => {
    const grants = (tools: unknown) => {
      const [ref] = listAgents([agent('Case', { properties: { tools } })]);
      return { shell: ref.shell, web: ref.web };
    };
    expect(grants('web')).toEqual({ shell: false, web: true });
    expect(grants(['shell', 'web'])).toEqual({ shell: true, web: true });
    expect(grants(['web'])).toEqual({ shell: false, web: true });
    expect(grants('shell')).toEqual({ shell: true, web: false });
    expect(grants('safe')).toEqual({ shell: false, web: false });
    expect(grants(undefined)).toEqual({ shell: false, web: false });
    // Unknown words, other shapes and wrong case are ignored, so an odd
    // value grants nothing.
    expect(grants(['web', 'everything', 3])).toEqual({ shell: false, web: true });
    expect(grants('Web')).toEqual({ shell: false, web: false });
    expect(grants('shell, web')).toEqual({ shell: false, web: false });
    expect(grants({ web: true })).toEqual({ shell: false, web: false });
    expect(grants(true)).toEqual({ shell: false, web: false });
  });

  it('skips unparseable records', () => {
    expect(listAgents([agent('Broken', { parseError: 'bad yaml' })])).toEqual([]);
  });

  it('parses read-scope on its own axis, with the null-vs-empty reading scope has (M34.4)', () => {
    const refs = listAgents([
      agent('Bounded', { properties: { 'read-scope': ['sources/', './knowledge'] } }),
      agent('Blind', { properties: { 'read-scope': [] } }),
      agent('Open', { properties: {} }),
    ]);
    const by = (t: string) => refs.find((r) => r.title === t);
    expect(by('Bounded')?.readScope).toEqual(['sources', 'knowledge']);
    // Declared-and-empty reads NOTHING; undeclared reads everywhere. Folding
    // these would make the safest-looking declaration the most dangerous one.
    expect(by('Blind')?.readScope).toEqual([]);
    expect(by('Open')?.readScope).toBeNull();
  });

  it('parses capabilities, and an undeclared list is empty — not null, not knowledge', () => {
    // M34.1.3: a capability selects prompt TEXT, never a code path. Empty by
    // default because no agent is the knowledge agent unless it says so.
    const refs = listAgents([
      agent('Curator', { properties: { capabilities: ['knowledge'] } }),
      agent('Release scout', { properties: {} }),
    ]);
    const curator = refs.find((r) => r.title === 'Curator');
    const scout = refs.find((r) => r.title === 'Release scout');
    expect(curator?.capabilities).toEqual(['knowledge']);
    expect(scout?.capabilities).toEqual([]);
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

  it('reads `disallowed-tools:` with the same grammar, absent apart from empty (M54.9)', () => {
    expect(agentRef(agent({})).disallowedTools).toBeNull();
    expect(
      agentRef(agent({ 'disallowed-tools': ['mcp__gmail__trash_thread', ' mcp__slack '] }))
        .disallowedTools,
    ).toEqual(['mcp__gmail__trash_thread', 'mcp__slack']);
    expect(agentRef(agent({ 'disallowed-tools': 'mcp__gmail' })).disallowedTools).toEqual([
      'mcp__gmail',
    ]);
    expect(agentRef(agent({ 'disallowed-tools': [] })).disallowedTools).toEqual([]);
  });

  it('reads `model:` and `effort:` trimmed, and blank or non-string as unset (M56.5)', () => {
    const ref = agentRef(agent({ model: ' sonnet ', effort: 'high' }));
    expect([ref.model, ref.effort]).toEqual(['sonnet', 'high']);
    const unset = agentRef(agent({ model: '  ', effort: 3 }));
    expect([unset.model, unset.effort]).toEqual([null, null]);
    expect(agentRef(agent({})).model).toBeNull();
    // Validity is the agent page's and Rust's, not the parser's.
    expect(agentRef(agent({ effort: 'turbo' })).effort).toBe('turbo');
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

  // M56.13 — a hand-written [[link]] sends the field to relationships,
  // bracket-stripped (CV-09), and the tier used to read as empty.
  describe('a tier that holds a [[link]]', () => {
    const withLinks = (
      properties: Record<string, unknown>,
      relationships: Record<string, string[]>,
    ) =>
      agentRef(
        makeEntry({
          path: 'records/agents/scout.md',
          title: 'Scout',
          type: 'Agent',
          properties: properties as never,
          relationships,
        }),
      ).memory;

    it('reads back with its links, in the order written', () => {
      // `preferences: "Ask [[maya-chen]] before touching [[atlas]]"` and a
      // `recent:` list naming two notes, as the scanner hands them over.
      const memory = withLinks(
        {},
        { preferences: ['maya-chen', 'atlas'], recent: ['risk-register', 'q3-plan'] },
      );
      expect(memory).toEqual({
        recent: '[[risk-register]]\n[[q3-plan]]',
        preferences: '[[maya-chen]]\n[[atlas]]',
      });
    });

    it('leaves plain text as it was, and prefers it over another key’s links', () => {
      const memory = withLinks(
        { recent: '  saw three risks  ', preferences: 'be terser' },
        { project: ['atlas'] },
      );
      expect(memory).toEqual({ recent: 'saw three risks', preferences: 'be terser' });
    });

    it('reads a linked pre-M17.14 memory:, and a linked recent: over a plain one', () => {
      expect(withLinks({}, { memory: ['old-note'] }).recent).toBe('[[old-note]]');
      expect(withLinks({ memory: 'old notes' }, {}).recent).toBe('old notes');
      expect(withLinks({ memory: 'old notes' }, { recent: ['new-note'] }).recent).toBe(
        '[[new-note]]',
      );
    });

    it('is empty for a relation that names nothing', () => {
      expect(withLinks({}, { preferences: [' ', ''] }).preferences).toBe('');
    });

    it('rebuilds on read and never writes the entry', () => {
      const entry = makeEntry({
        path: 'records/agents/scout.md',
        title: 'Scout',
        type: 'Agent',
        relationships: { preferences: ['atlas'] },
      });
      const before = structuredClone(entry);
      expect(agentRef(entry).memory.preferences).toBe('[[atlas]]');
      expect(entry).toEqual(before);
    });

    it('names the tiers it rebuilt from links, so nothing saves over them', () => {
      const entry = (
        properties: Record<string, unknown>,
        relationships: Record<string, string[]>,
      ) =>
        makeEntry({
          path: 'records/agents/scout.md',
          title: 'Scout',
          type: 'Agent',
          properties: properties as never,
          relationships,
        });
      expect(linkedTiers(entry({}, { preferences: ['maya-chen', 'atlas'] }))).toEqual({
        recent: false,
        preferences: true,
      });
      expect(linkedTiers(entry({ preferences: 'be terser' }, { preferences: ['atlas'] }))).toEqual({
        recent: false,
        preferences: false,
      });
      expect(linkedTiers(entry({}, { memory: ['old-note'] })).recent).toBe(true);
      expect(linkedTiers(entry({ recent: 'plain' }, { memory: ['old-note'] })).recent).toBe(false);
      expect(linkedTiers(entry({}, { preferences: [' '] })).preferences).toBe(false);
    });
  });
});

/**
 * M33b.6 — addressing an agent by name.
 *
 * The handle is not a new identity: it is the slug the actor is already built
 * from, so the agent you address is by construction the agent whose name lands
 * in `generated.by`. That is the whole reason this resolves through
 * `declaredSlug`/`recordIdentity` rather than through a second rule.
 */
describe('readAddress', () => {
  const scout = makeEntry({
    path: 'records/agents/scout.md',
    title: 'Release scout',
    type: 'Agent',
    properties: { slug: 'release-scout', scope: ['records/risks'] } as never,
  });
  const note = makeEntry({ path: 'work/ship.md', title: 'Ship the beta', type: 'Work item' });

  it('addresses nobody when nobody was named', () => {
    expect(readAddress('what is at risk?', [scout, note])).toBeNull();
  });

  it('resolves a handle to the agent whose writes carry it', () => {
    const address = readAddress('@release-scout what is slipping?', [scout, note]);
    expect(address?.handle).toBe('release-scout');
    expect(address?.agent?.actor).toBe('process:release-scout');
    expect(address?.agent?.scope).toEqual(['records/risks']);
  });

  it('finds the mention mid-sentence, on a word boundary', () => {
    expect(readAddress('ask @release-scout about it', [scout])?.agent?.title).toBe('Release scout');
  });

  it('is not fooled by an email address', () => {
    // The same boundary rule the composer's `@` menu uses, so a token that
    // opens no menu there routes nothing here either.
    expect(readAddress('mail josef@release-scout.com', [scout])).toBeNull();
  });

  it('follows a renamed record, because the declared slug is the identity', () => {
    // The record was renamed and its file moved; the handle it answers to did
    // not move, which is the same guarantee M17.8 gave the ledger and the
    // actor. Resolving on the title would have retired `@release-scout` here.
    const renamed = makeEntry({
      path: 'records/agents/watcher.md',
      title: 'Ship watcher',
      type: 'Agent',
      properties: { slug: 'release-scout' } as never,
    });
    const address = readAddress('@release-scout status?', [renamed]);
    expect(address?.agent?.title).toBe('Ship watcher');
    expect(address?.agent?.actor).toBe('process:release-scout');
  });

  it('falls back to the title when the record declares no slug', () => {
    const plain = makeEntry({
      path: 'records/agents/scout.md',
      title: 'Release scout',
      type: 'Agent',
    });
    expect(readAddress('@release-scout hi', [plain])?.agent?.handle).toBe('release-scout');
  });

  it('carries the handle out when nothing matches, so the mention is not silent', () => {
    // Not an error and not a no-op. The `@name` was only ever text — and the
    // person still has to be able to find out that it did not route.
    const address = readAddress('@nobody-here are you there?', [scout]);
    expect(address).not.toBeNull();
    expect(address?.handle).toBe('nobody-here');
    expect(address?.agent).toBeNull();
  });

  it('names one recipient — a turn has one grant, so it has one', () => {
    const other = makeEntry({
      path: 'records/agents/librarian.md',
      title: 'Librarian',
      type: 'Agent',
    });
    expect(readAddress('@release-scout and @librarian', [scout, other])?.agent?.title).toBe(
      'Release scout',
    );
  });

  it('ignores a record that is not an agent', () => {
    expect(readAddress('@ship-the-beta please', [note])?.agent).toBeNull();
  });
});

/**
 * Two narrowings can meet on one turn (M33b.6): a skill's `allowed-tools:` and
 * the addressed agent's. The direction is the whole safety property — every
 * layer subtracts, no layer adds.
 */
describe('narrowTools', () => {
  it('yields to the other side when one declares nothing', () => {
    expect(narrowTools(null, ['get_note'])).toEqual(['get_note']);
    expect(narrowTools(['get_note'], null)).toEqual(['get_note']);
    expect(narrowTools(null, null)).toBeNull();
  });

  it('intersects rather than unions — a recipient cannot widen a skill', () => {
    expect(narrowTools(['get_note', 'search_notes'], ['search_notes', 'create_note'])).toEqual([
      'search_notes',
    ]);
  });

  it('keeps "narrowed to nothing" narrowed to nothing', () => {
    // `[]` is a real declaration, and the opposite of null. A read-only skill
    // that asked for no tools must not be widened by whoever it is addressed to.
    expect(narrowTools([], ['get_note'])).toEqual([]);
    expect(narrowTools(['get_note'], [])).toEqual([]);
  });
});

describe('askFirstOf (M57.4)', () => {
  it('replays the tool-approval artifact’s ask_first cases', () => {
    const { record_key: key, cases } = TOOL_APPROVAL.ask_first;
    for (const c of cases) {
      const entry = agent('Release Scout', {
        properties: {
          tools: 'safe',
          ...(c.held === 'property' ? { [key]: c.value } : {}),
        },
        ...(c.held === 'relation' ? { relationships: { [key]: c.value as string[] } } : {}),
      });
      const read = askFirstOf(entry);
      expect(read.on, c.why).toBe(c.on);
      expect(read.warning !== null, c.why).toBe(c.warn);
      expect(agentRef(entry).askFirst, c.why).toBe(c.on);
    }
  });

  it('reads a relation-valued ask-first on, and warns with its links', () => {
    const entry = agent('Release Scout', { relationships: { 'ask-first': ['release-scout'] } });
    expect(askFirstOf(entry)).toEqual({
      on: true,
      warning: 'ask-first: [[release-scout]] — read as on until you choose',
    });
    expect(agentRef(entry).askFirstWarning).toBe(
      'ask-first: [[release-scout]] — read as on until you choose',
    );
  });

  it('names an odd value as the file holds it', () => {
    const odd = (value: unknown) =>
      askFirstOf(agent('Scout', { properties: { 'ask-first': value } })).warning;
    expect(odd('yes')).toBe('ask-first: yes — read as on until you choose');
    expect(odd(1)).toBe('ask-first: 1 — read as on until you choose');
    expect(odd(true)).toBeNull();
    expect(odd(false)).toBeNull();
    expect(agentRef(agent('Scout')).askFirst).toBe(false);
  });
});

describe('isPaused (M18; here since M63.1)', () => {
  it('reads paused: true only', () => {
    const agent = (paused: unknown) =>
      makeEntry({ type: 'Agent', properties: paused === undefined ? {} : { paused } });
    expect(isPaused(agent(true))).toBe(true);
    for (const off of [undefined, false, 'true', 'yes', 1, null]) {
      expect(isPaused(agent(off))).toBe(false);
    }
    expect(reexported).toBe(isPaused);
  });
});
