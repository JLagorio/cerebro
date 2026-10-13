import { describe, expect, it } from 'vitest';
import { actorLabel, CONSTRUCT_ACTORS, resolveAuthor } from './authors';
import { parseActor } from './okf';
import { makeEntry } from './testHelpers';

const knowledgeAgent = makeEntry({
  path: 'records/agents/knowledge.md',
  title: 'Knowledge',
  type: 'Agent',
  properties: { description: 'Maintains the bundle.', tools: 'safe' },
});

const tom = makeEntry({ path: 'people/tom-keller.md', title: 'Tom Keller', type: 'Person' });

const resolve = (raw: string, entries = [knowledgeAgent]) =>
  resolveAuthor(parseActor(raw)!, entries);

describe('resolveAuthor (M50.3)', () => {
  it('reads an agent stamp as that agent, by actor', () => {
    expect(resolve('process:knowledge')).toEqual({
      kind: 'agent',
      title: 'Knowledge',
      path: 'records/agents/knowledge.md',
      actor: 'process:knowledge',
    });
  });

  it("reads the attended assistant's stamp, in both spellings, as the Assistant", () => {
    expect(resolve('claude-code').kind).toBe('assistant');
    expect(resolve('claude-code/2.0').kind).toBe('assistant');
  });

  it('keeps a person, and shows an unknown stamp as written rather than guessing', () => {
    expect(resolve('human:josef')).toEqual({ kind: 'human', label: 'josef' });
    expect(resolve('process:gone')).toEqual({ kind: 'other', label: 'gone' });
    // A title is not an identity: an agent named "Knowledge" does not claim
    // a stamp that merely says so.
    expect(resolve('Knowledge')).toEqual({ kind: 'other', label: 'Knowledge' });
  });
});

describe('resolveAuthor — a person is their page (M52.3)', () => {
  it('names the one page whose file answers to the id, and says where it is', () => {
    expect(resolve('human:tom-keller', [tom])).toEqual({
      kind: 'human',
      label: 'Tom Keller',
      path: 'people/tom-keller.md',
    });
  });

  it('matches a declared slug as well as a file name', () => {
    const renamed = makeEntry({
      path: 'people/thomas.md',
      title: 'Thomas Keller',
      properties: { slug: 'tom-keller' },
    });
    expect(resolve('human:tom-keller', [renamed])).toMatchObject({ label: 'Thomas Keller' });
  });

  it('refuses to guess between two pages that both answer', () => {
    const twin = makeEntry({ path: 'contacts/tom-keller.md', title: 'T. Keller (vendor)' });
    expect(resolve('human:tom-keller', [tom, twin])).toEqual({
      kind: 'human',
      label: 'tom-keller',
    });
  });

  it('never takes a concept for a person', () => {
    const concept = makeEntry({ path: 'knowledge/people/tom-keller.md', title: 'Tom, the claim' });
    expect(resolve('human:tom-keller', [concept, tom])).toMatchObject({ label: 'Tom Keller' });
    expect(resolve('human:tom-keller', [concept])).toEqual({ kind: 'human', label: 'tom-keller' });
  });

  it('matches on identity, never on a type name', () => {
    // No `type: Person` here and none needed: the file answering is the rule.
    const untyped = makeEntry({ path: 'team/ana-rios.md', title: 'Ana Rios', type: null });
    expect(resolve('human:ana-rios', [untyped])).toMatchObject({ path: 'team/ana-rios.md' });
  });
});

describe('actorLabel (M52.3)', () => {
  const entries = [knowledgeAgent, tom];
  const label = (raw: string | null) => actorLabel(raw, entries);

  it('reads an agent as its record, carrying the actor for a link', () => {
    expect(label('process:knowledge')).toEqual({
      text: 'Knowledge',
      raw: 'process:knowledge',
      actor: 'process:knowledge',
    });
  });

  it('reads the attended assistant as the Assistant, in both spellings', () => {
    expect(label('claude-code')).toEqual({ text: 'Assistant', raw: 'claude-code' });
    expect(label('claude-code/2.0').text).toBe('Assistant');
  });

  it('names every construct as background work, never by its raw id', () => {
    expect(CONSTRUCT_ACTORS.map((c) => label(c.actor).text)).toEqual([
      'Background ingest',
      'Background maintenance',
      'Background synthesis',
    ]);
    expect(label('agent:m26-ingest').raw).toBe('agent:m26-ingest');
    expect(label('agent:m26-ingest').actor).toBeUndefined();
  });

  it('says unattributed for a run nobody attributed — a category, not a blank', () => {
    expect(label(null)).toEqual({ text: 'unattributed', raw: null });
  });

  it('shows an unknown stamp as written rather than guessing, and a person by name', () => {
    expect(label('process:gone')).toEqual({ text: 'process:gone', raw: 'process:gone' });
    expect(label('human:tom-keller')).toEqual({ text: 'Tom Keller', raw: 'human:tom-keller' });
    expect(label('human:josef').text).toBe('josef');
  });
});
