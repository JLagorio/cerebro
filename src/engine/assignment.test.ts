import { describe, expect, it } from 'vitest';
import {
  agentFieldNames,
  agentFieldsOf,
  assignedWakes,
  assignmentPrefix,
  isAgentField,
  inheritedAgentsPatch,
  withInheritedAgents,
  linksAgent,
  stillAssigned,
  unassignments,
} from './assignment';
import { buildSchema } from './schema';
import { makeEntry } from './testHelpers';
import type { Entry, FieldDef } from './types';
import { diffEntries } from './events';
import { sha256Hex } from '@/lib/sha256';
import { applyEntryPatch } from './entryPatch';

const type = makeEntry({
  path: 'types/task.md',
  title: 'Task',
  type: 'Type',
  properties: {
    fields: {
      agent: { kind: 'relation', target: 'Agent' },
      owner: { kind: 'person', target: 'Agent' },
      loose: { kind: 'relation' },
      reverse: { kind: 'relation', target: 'Agent', from: { type: 'Agent', field: 'tasks' } },
    },
  },
});
const scout = makeEntry({
  path: 'records/agents/scout.md',
  filename: 'scout.md',
  folder: 'records/agents',
  title: 'Release scout',
  type: 'Agent',
  properties: { slug: 'scout', when: [{ event: 'assigned', field: 'agent' }] },
});
const work = (key: string, links: string[] = [], patch: Partial<Entry> = {}) =>
  makeEntry({
    path: `tasks/${key}.md`,
    filename: `${key}.md`,
    folder: 'tasks',
    title: key,
    type: 'Task',
    relationships: { agent: links },
    hash: sha256Hex(`${key}:${links.join(',')}`),
    ...patch,
  });
const schema = buildSchema([type, scout]);
const added = (before: Entry[], after: Entry[], agents = [scout]) =>
  assignedWakes([type, ...agents, ...after], diffEntries(before, after), schema);

describe('assignment fields', () => {
  it('requires a stored, declared Agent relation', () => {
    expect(agentFieldsOf('Task', schema).map((field) => field.name)).toEqual(['agent']);
    expect(agentFieldsOf(null, schema)).toEqual([]);
    expect(isAgentField({ kind: 'text', name: 'agent', target: 'Agent' } as FieldDef)).toBe(false);
    expect(agentFieldNames(schema)).toEqual([
      { field: 'agent', type: 'Task', label: 'agent (Task)' },
    ]);
  });
  it('resolves stems, titles and fragments through the shared target rules', () => {
    for (const target of ['scout', 'Release scout', 'scout#Instructions']) {
      expect(linksAgent(work('a', [target]), 'agent', scout, [scout], schema), target).toBe(true);
    }
    expect(linksAgent(work('a', ['Nobody']), 'agent', scout, [scout], schema)).toBe(false);
    expect(linksAgent(work('a', ['scout']), 'owner', scout, [scout], schema)).toBe(false);
  });
});

describe('assignedWakes', () => {
  it('admits an already assigned create once with a replay-stable key', () => {
    const entry = work('a', ['scout']);
    const offers = added([], [entry]);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      agent: 'process:scout',
      path: entry.path,
      hash: entry.hash,
      event: 'created',
      cause: { kind: 'assigned', subject: entry.path, detail: 'via agent' },
    });
    expect(offers[0].wakeKey).toMatch(/^assigned:[0-9a-f]{8}:[0-9a-f]{32}$/);
    expect(added([], [entry])).toEqual(offers);
  });
  it('adds on a gained link, not on keeping or removing it', () => {
    const before = work('a');
    const after = work('a', ['scout']);
    expect(added([before], [after])).toHaveLength(1);
    expect(added([after], [{ ...after, hash: sha256Hex('body changed') }])).toEqual([]);
    expect(added([after], [before])).toEqual([]);
    expect(added([before], [after])[0].wakeKey).not.toBe(added([], [after])[0].wakeKey);
  });
  it('three pages give three independent keys and duplicate links give one wake', () => {
    const pages = ['a', 'b', 'c'].map((key) => work(key, ['scout', 'Release scout']));
    const offers = added([], pages);
    expect(offers).toHaveLength(3);
    expect(new Set(offers.map((offer) => offer.wakeKey)).size).toBe(3);
  });
  it('never wakes paused or unreadable agents, another agent, nonagents or a knowledge page', () => {
    for (const agent of [
      { ...scout, properties: { ...scout.properties, paused: true } },
      { ...scout, parseError: 'bad' },
      { ...scout, type: 'Person' },
      { ...scout, path: 'knowledge/scout.md', folder: 'knowledge' },
    ]) {
      expect(added([], [work('a', ['scout'])], [agent])).toEqual([]);
    }
    expect(added([], [work('a', ['other'])])).toEqual([]);
  });
  it('skips moves, unknown bytes, unreadable subjects and the agent’s own page', () => {
    const entry = work('a', ['scout']);
    expect(
      assignedWakes(
        [type, scout, entry],
        [{ kind: 'moved', path: entry.path, from: 'old/a.md', entry }],
        schema,
      ),
    ).toEqual([]);
    for (const patch of [{ hash: null }, { parseError: 'bad' }, { path: scout.path }])
      expect(added([], [work('a', ['scout'], patch)])).toEqual([]);
    // Recovering an unreadable page proves no newly gained link.
    expect(added([work('a', [], { parseError: 'bad' })], [work('a', ['scout'])])).toEqual([]);
  });
  it('the first matching assignment trigger wins and folder limits use separators', () => {
    const watcher = {
      ...scout,
      properties: {
        ...scout.properties,
        when: [
          { event: 'assigned', field: 'agent', in: 'tasks', do: 'first' },
          { event: 'assigned', field: 'agent', do: 'second' },
        ],
      },
    } as unknown as Entry;
    expect(added([], [work('a', ['scout'])], [watcher])).toHaveLength(1);
    const limited = {
      ...watcher,
      properties: {
        ...watcher.properties,
        when: [{ event: 'assigned', field: 'agent', in: 'task' }],
      },
    } as unknown as Entry;
    expect(added([], [work('a', ['scout'])], [limited])).toEqual([]);
  });
});

describe('assignment releases', () => {
  it('removes one agent/page/field identity even when two stored spellings linked it', () => {
    const before = work('a', ['scout', 'Release scout']);
    const after = work('a');
    const events = diffEntries([before], [after]);
    expect(unassignments([type, scout, after], events, schema)).toEqual([
      { agent: 'process:scout', subject: after.path, keyPrefix: assignmentPrefix('agent') },
    ]);
    expect(unassignments([type, scout, before], diffEntries([after], [before]), schema)).toEqual(
      [],
    );
  });
  it('rechecks the declared field, existing agent, trigger and link before a claim', () => {
    const entry = work('a', ['scout']);
    const [wake] = added([], [entry]);
    expect(stillAssigned(wake, [type, scout, entry], schema)).toBe(true);
    expect(stillAssigned(wake, [type, scout, work('a')], schema)).toBe(false);
    expect(stillAssigned(wake, [type, entry], schema)).toBe(false);
    expect(stillAssigned(wake, [type, { ...scout, properties: {} }, entry], schema)).toBe(false);
    expect(stillAssigned({ ...wake, cause: { kind: 'event' } }, [], schema)).toBe(true);
  });
});

describe('human filing inherits agents', () => {
  const taskType = (
    agentFields: Record<string, unknown> = { agent: { kind: 'relation', target: 'Agent' } },
  ) =>
    makeEntry({
      path: 'types/task.md',
      type: 'Type',
      title: 'Task',
      properties: {
        fields: { project: { kind: 'relation', target: 'Project', limit: 1 }, ...agentFields },
      } as never,
    });
  const hostType = makeEntry({
    path: 'types/project.md',
    type: 'Type',
    title: 'Project',
    properties: {
      fields: { agents: { kind: 'relation', target: 'Agent' } },
      tabs: [
        { id: 'tasks', name: 'Tasks', content: 'view', source: { type: 'Task' }, scope: 'related' },
      ],
    } as never,
  });
  const second = makeEntry({
    path: 'agents/second.md',
    title: 'Second',
    type: 'Agent',
    properties: { slug: 'second' },
  });
  const host = (slug: string, links: string[]) =>
    makeEntry({
      path: `projects/${slug}.md`,
      title: slug,
      type: 'Project',
      relationships: { agents: links },
    });
  const all = [
    taskType(),
    hostType,
    scout,
    second,
    host('old', ['scout']),
    host('new', ['second', 'Release scout']),
  ];
  const inherited = (before: Entry | null, patch: Record<string, unknown>, entries = all) =>
    inheritedAgentsPatch(before, 'Task', patch, entries, buildSchema(entries));

  it('a create gets new host agents in link order, with stem links', () => {
    expect(inherited(null, { project: ['[[new]]'] })).toEqual({
      agent: ['[[second]]', '[[scout]]'],
    });
  });
  it('a move adds the new host agents and keeps old authored spellings', () => {
    const before = work('a', ['Release scout'], {
      relationships: { project: ['old'], agent: ['Release scout'] },
    });
    expect(inherited(before, { project: ['[[new]]'] })).toEqual({
      agent: ['[[Release scout]]', '[[second]]'],
    });
    expect(inherited(before, { project: null })).toBeNull();
    expect(inherited(before, { project: ['[[old]]'] })).toBeNull();
    expect(inherited(before, { status: 'done' })).toBeNull();
  });
  it('an explicit agent patch always wins, including a clear', () => {
    for (const agent of [null, [], ['[[second]]'], undefined])
      expect(inherited(null, { project: ['[[new]]'], agent })).toBeNull();
  });
  it('zero or several receiving fields infer nothing', () => {
    for (const fields of [
      {},
      {
        agent: { kind: 'relation', target: 'Agent' },
        helper: { kind: 'relation', target: 'Agent' },
      },
    ]) {
      expect(
        inherited(null, { project: ['[[new]]'] }, [taskType(fields), ...all.slice(1)]),
      ).toBeNull();
    }
  });
  it('dangling, nonagent and duplicate links add nothing extra', () => {
    const person = makeEntry({ path: 'people/person.md', type: 'Person' });
    const entries = [...all, person, host('mixed', ['Nobody', 'person', 'scout', 'Release scout'])];
    expect(inherited(null, { project: ['[[mixed]]'] }, entries)).toEqual({ agent: ['[[scout]]'] });
    expect(inherited(null, { project: ['[[Nobody]]'] }, entries)).toBeNull();
  });
  it('a single-link receiver fills only when empty and exactly one agent is gained', () => {
    const entries = [
      taskType({ agent: { kind: 'relation', target: 'Agent', limit: 1 } }),
      ...all.slice(1),
    ];
    expect(inherited(null, { project: ['[[old]]'] }, entries)).toEqual({ agent: ['[[scout]]'] });
    expect(inherited(null, { project: ['[[new]]'] }, entries)).toBeNull();
    expect(inherited(work('a', ['second']), { project: ['[[old]]'] }, entries)).toBeNull();
  });
  it('only patch ops from an opted-in human action inherit', () => {
    const before = work('a');
    const entries = [...all, before];
    const remove = { op: 'delete' as const, path: before.path, expectHash: 'h' };
    const ops = [
      { op: 'patch' as const, path: before.path, expectHash: 'h', set: { project: ['[[old]]'] } },
      remove,
    ];
    expect(withInheritedAgents(ops, entries, buildSchema(entries))).toEqual([
      { ...ops[0], set: { project: ['[[old]]'], agent: ['[[scout]]'] } },
      remove,
    ]);
    expect(ops[0]).toMatchObject({ set: { project: ['[[old]]'] } });
  });
  it('a created inherited assignment produces one assigned wake', () => {
    const patch = { project: ['[[old]]'], ...inherited(null, { project: ['[[old]]'] }) };
    const created = { ...applyEntryPatch(work('a'), patch), hash: sha256Hex('created') };
    const entries = [...all, created];
    const wakes = assignedWakes(
      entries,
      [{ kind: 'created', path: created.path, entry: created }],
      buildSchema(entries),
    );
    expect(wakes).toHaveLength(1);
    expect(wakes[0].cause).toEqual({
      kind: 'assigned',
      subject: created.path,
      detail: 'via agent',
    });
  });
});
