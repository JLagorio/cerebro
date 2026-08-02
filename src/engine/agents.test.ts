import { describe, expect, it } from 'vitest';
import { listAgents } from './agents';
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
    expect(wide?.memory).toBe('knows a thing');
    expect(bare?.shell).toBe(false);
    expect(bare?.memory).toBe('');
  });

  it('skips unparseable records', () => {
    expect(listAgents([agent('Broken', { parseError: 'bad yaml' })])).toEqual([]);
  });
});
