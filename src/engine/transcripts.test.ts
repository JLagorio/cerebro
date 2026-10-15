import { describe, expect, it } from 'vitest';
import { buildSchema } from './schema';
import { makeEntry } from './testHelpers';
import { matchSpeakers, speakerLink, transcriptFacts } from './transcripts';
import type { Entry } from './types';

/** An entry whose filename and folder follow its path, as the scanner gives them. */
function at(path: string, rest: Parameters<typeof makeEntry>[0] = {}): Entry {
  const slash = path.lastIndexOf('/');
  return makeEntry({
    path,
    filename: path.slice(slash + 1),
    folder: slash === -1 ? '' : path.slice(0, slash),
    ...rest,
  });
}

/**
 * A vault where people are whatever a person field points at. The Meeting
 * doc's `attendees` field is untargeted, so its records' relationships (CV-09)
 * decide the people type, and it is `Teammate`, not the conventional Person.
 */
function vault(extra: Entry[] = []): Entry[] {
  return [
    at('types/meeting.md', {
      title: 'Meeting',
      type: 'Type',
      properties: { fields: { attendees: { kind: 'person' } } },
    }),
    at('types/teammate.md', { title: 'Teammate', type: 'Type', properties: { fields: {} } }),
    at('records/meetings/kickoff.md', {
      title: 'Kickoff',
      type: 'Meeting',
      relationships: { attendees: ['marcus-webb'] },
    }),
    at('team/marcus-webb.md', { title: 'Marcus Webb', type: 'Teammate' }),
    at('team/pn.md', { title: 'P. Nair', type: 'Teammate', properties: { slug: 'priya-nair' } }),
    at('team/tom-keller.md', { title: 'Tom Keller', type: 'Teammate' }),
    at('team/tom-keller-2.md', { title: 'Tom Keller', type: 'Teammate' }),
    ...extra,
  ];
}

const capture = (properties: Record<string, unknown>, relationships = {}) =>
  at('inbox/standup.md', { title: 'Standup', properties, relationships });

describe('transcriptFacts', () => {
  it('answers only for vtt and srt captures', () => {
    for (const format of ['vtt', 'srt']) {
      expect(transcriptFacts(capture({ ingest_format: format, speakers: [] }))).not.toBeNull();
    }
    for (const format of ['markdown', 'text', undefined, 3]) {
      expect(transcriptFacts(capture({ ingest_format: format, speakers: ['A'] }))).toBeNull();
    }
  });

  it('reads an absent key as not recorded, and [] as nobody', () => {
    expect(transcriptFacts(capture({ ingest_format: 'vtt' }))).toEqual({ speakers: null });
    expect(transcriptFacts(capture({ ingest_format: 'vtt', speakers: [] }))).toEqual({
      speakers: [],
    });
  });

  it('takes a single string, a list, and links the file already holds (CV-09)', () => {
    expect(transcriptFacts(capture({ ingest_format: 'srt', speakers: 'Tom' }))?.speakers).toEqual([
      { label: 'Tom', link: null },
    ]);
    const linked = capture({ ingest_format: 'vtt' }, { speakers: ['marcus-webb'] });
    expect(transcriptFacts(linked)?.speakers).toEqual([
      { label: 'marcus-webb', link: 'marcus-webb' },
    ]);
  });
});

describe('matchSpeakers', () => {
  const entries = vault();
  const schema = buildSchema(entries);

  it('matches a title ignoring case', () => {
    const [m] = matchSpeakers(['marcus WEBB'], schema, entries);
    expect(m).toMatchObject({ kind: 'matched', label: 'marcus WEBB', link: '[[marcus-webb]]' });
    expect(m.kind === 'matched' && m.page.path).toBe('team/marcus-webb.md');
  });

  it('matches a slug against the filename stem and a declared slug', () => {
    const byStem = vault([at('team/sam-ito.md', { title: 'S. Ito', type: 'Teammate' })]);
    const [stem] = matchSpeakers(['Sam Ito'], buildSchema(byStem), byStem);
    expect(stem.kind === 'matched' && stem.page.path).toBe('team/sam-ito.md');
    const [declared] = matchSpeakers(['Priya Nair'], schema, entries);
    expect(declared.kind === 'matched' && declared.page.path).toBe('team/pn.md');
  });

  it('names two or more hits as ambiguous, with the count, and never guesses', () => {
    expect(matchSpeakers(['Tom Keller'], schema, entries)).toEqual([
      { label: 'Tom Keller', kind: 'ambiguous', count: 2 },
    ]);
  });

  it('says none for a label with no page, and for a blank one', () => {
    expect(matchSpeakers(['Jo Nobody', '  '], schema, entries)).toEqual([
      { label: 'Jo Nobody', kind: 'none' },
      { label: '  ', kind: 'none' },
    ]);
  });

  it('never matches knowledge/, a Type doc, or a page that is not a person', () => {
    const tricky = vault([
      at('knowledge/people/ana-rios.md', { title: 'Ana Rios', type: 'Teammate' }),
      at('types/lena-ortiz.md', { title: 'Lena Ortiz', type: 'Type' }),
      at('records/projects/dana-fox.md', { title: 'Dana Fox', type: 'Project' }),
    ]);
    const s = buildSchema(tricky);
    expect(
      matchSpeakers(['Ana Rios', 'Lena Ortiz', 'Dana Fox'], s, tricky).map((m) => m.kind),
    ).toEqual(['none', 'none', 'none']);
  });

  it('counts a speaker the file already links as matched to the page it reaches', () => {
    const [linked, dangling] = matchSpeakers(
      [
        { label: 'marcus-webb', link: 'marcus-webb' },
        { label: 'ghost', link: 'ghost' },
      ],
      schema,
      entries,
    );
    expect(linked.kind === 'matched' && linked.page.path).toBe('team/marcus-webb.md');
    expect(dangling.kind).toBe('none');
  });

  it('writes the link by the name that reaches the page', () => {
    const page = entries.find((e) => e.path === 'team/tom-keller-2.md') as Entry;
    expect(speakerLink(page, entries)).toBe('[[tom-keller-2]]');
  });
});
