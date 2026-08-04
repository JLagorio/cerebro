import { describe, expect, it } from 'vitest';
import { diffEntries } from './events';
import { describeTrigger, fires, firstMatch, parseTriggers } from './triggers';
import { makeEntry } from './testHelpers';

const risk = (over: Parameters<typeof makeEntry>[0] = { path: 'records/risks/a.md' }) =>
  makeEntry({
    path: 'records/risks/a.md',
    title: 'A risk',
    type: 'Risk',
    properties: { status: 'open' },
    modifiedAt: '2026-08-01T09:00:00Z',
    ...over,
  });

describe('diffEntries', () => {
  it('reports nothing at all on the first scan of a session', () => {
    // Otherwise every note in the vault reads as "created" and every trigger
    // fires at once, every launch.
    expect(diffEntries(null, [risk()])).toEqual([]);
  });

  it('sees a new record as created', () => {
    const events = diffEntries([], [risk()]);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('created');
  });

  it('names the properties that actually changed', () => {
    const before = risk();
    const after = risk({
      path: 'records/risks/a.md',
      properties: { status: 'blocked' },
      modifiedAt: '2026-08-02T09:00:00Z',
    });
    const [event] = diffEntries([before], [after]);
    expect(event.kind).toBe('changed');
    expect(event.kind === 'changed' && event.fields).toEqual(['status']);
  });

  it('ignores a note nothing happened to', () => {
    expect(diffEntries([risk()], [risk()])).toEqual([]);
  });

  it('tells a move apart from a delete plus a create', () => {
    const before = risk();
    const after = risk({ path: 'archive/a.md' });
    const [event] = diffEntries([before], [after]);
    expect(event.kind).toBe('moved');
    expect(event.kind === 'moved' && event.from).toBe('records/risks/a.md');
  });

  it('says nothing about a deleted record', () => {
    // A trigger firing on a deletion would hand an agent a path it cannot
    // read, and "react to something that is gone" has no useful meaning.
    expect(diffEntries([risk()], [])).toEqual([]);
  });
});

describe('parseTriggers', () => {
  it('reads the short form', () => {
    expect(parseTriggers('created')).toEqual([{ event: 'created' }]);
  });

  it('reads the long form and normalizes the folder', () => {
    expect(
      parseTriggers([{ event: 'changed', field: 'status', to: 'blocked', in: '/records/risks/' }]),
    ).toEqual([{ event: 'changed', field: 'status', to: 'blocked', in: 'records/risks' }]);
  });

  it('drops a trigger that constrains nothing rather than firing on everything', () => {
    // A trigger with no clauses fires on every change in the vault. Nobody
    // means that, so it is a typo — and honouring a typo is the worst outcome.
    expect(parseTriggers([{}, { nonsense: true }, 'whenever'])).toEqual([]);
  });

  it('survives a malformed entry without losing the good ones', () => {
    expect(parseTriggers([null, 'created', 42])).toEqual([{ event: 'created' }]);
  });
});

describe('layer one fires from the record alone', () => {
  const changed = diffEntries(
    [risk()],
    [
      risk({
        path: 'records/risks/a.md',
        properties: { status: 'blocked' },
        modifiedAt: '2026-08-02T09:00:00Z',
      }),
    ],
  )[0];

  it('matches an event, a field and a value', () => {
    expect(fires({ event: 'changed', field: 'status', to: 'blocked' }, changed)).toBe(true);
  });

  it('is AND, not OR — a partial match is a different situation', () => {
    expect(fires({ event: 'changed', field: 'status', to: 'done' }, changed)).toBe(false);
    expect(fires({ event: 'created', field: 'status' }, changed)).toBe(false);
  });

  it('confines by folder, and cannot be escaped by a shared prefix', () => {
    expect(fires({ in: 'records/risks' }, changed)).toBe(true);
    expect(fires({ in: 'records/risk' }, changed)).toBe(false);
    expect(fires({ in: 'records' }, changed)).toBe(true);
  });

  it('will not satisfy a field condition with a creation', () => {
    // `created` + `field: status` would otherwise fire for every new record
    // that merely carries the property — which is every record of that type.
    const created = diffEntries([], [risk()])[0];
    expect(fires({ field: 'status' }, created)).toBe(false);
  });

  it('needs a field before a value means anything', () => {
    expect(fires({ to: 'blocked' }, changed)).toBe(false);
  });

  it('takes the first match, so the most specific clause can be put first', () => {
    const first = firstMatch(
      [{ event: 'changed', field: 'status', to: 'blocked', ask: 'Real?' }, { event: 'changed' }],
      changed,
    );
    expect(first?.ask).toBe('Real?');
  });
});

describe('describeTrigger', () => {
  it('says what will fire it without anyone having to run it', () => {
    expect(
      describeTrigger({ event: 'changed', field: 'status', to: 'blocked', in: 'records' }),
    ).toBe('When a record changes in records and status becomes blocked.');
  });

  it('names the model gate as a second step rather than hiding it', () => {
    expect(describeTrigger({ event: 'created', ask: 'Is this a real risk?' })).toContain(
      'ask: Is this a real risk?',
    );
  });

  it('names the per-trigger instruction too, in the order the two run', () => {
    // M18.5. A summary that hid either half would defeat its own purpose —
    // you should be able to say what a trigger will do without running it.
    const sentence = describeTrigger({
      event: 'changed',
      field: 'status',
      to: 'at-risk',
      ask: 'Does this threaten the release?',
      do: 'Check the release date before writing anything.',
    });
    expect(sentence.indexOf('ask:')).toBeLessThan(sentence.indexOf('then:'));
    expect(sentence).toContain('then: Check the release date before writing anything.');
  });
});

describe('per-trigger instructions (M18.5)', () => {
  it('parses `do:` alongside the clause and the gate', () => {
    const [trigger] = parseTriggers([
      { event: 'changed', field: 'status', do: 'Only report, never file.' },
    ]);
    expect(trigger.do).toBe('Only report, never file.');
  });

  it('is separate from `ask:` — one decides whether, the other decides what', () => {
    // Folding them into one field is the tempting simplification and the
    // wrong one: a gate that also carries instructions gets answered "yes"
    // and then obeyed, so the agent acts on a waking it should have skipped.
    const [trigger] = parseTriggers([{ event: 'created', ask: 'Real?', do: 'File it.' }]);
    expect(trigger.ask).toBe('Real?');
    expect(trigger.do).toBe('File it.');
  });

  it('drops a blank one rather than carrying an empty instruction', () => {
    const [trigger] = parseTriggers([{ event: 'created', do: '   ' }]);
    expect('do' in trigger).toBe(false);
  });
});
