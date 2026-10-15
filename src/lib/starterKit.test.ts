// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/engine/schema';
import { checkView } from '@/engine/viewCheck';
import { resolveTarget } from '@/engine/wikilink';
import { agentRef, isPaused, parseScope } from '@/engine/agents';
import { grantedTools, mentionedTools } from '@/engine/toolGrant';
import { toolFacts } from '@/lib/policy/tools';
import RETIRED from '../../shared/prompt/retired-terms.json';
import RUST from '../../src-tauri/src/starter.rs?raw';
import * as mock from './mockIpc';

const VAULT = '/demo-vault';
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
beforeEach(() => mock.emptyMockVault());
afterEach(() => mock.resetMockFs());

describe('the starter kit', () => {
  it('installs exact shared bytes once, and a hidden marker stays outside the scan', async () => {
    expect(await mock.scanVault(VAULT)).toEqual([]);
    expect(await mock.reviewQueue(VAULT)).toEqual([]);
    expect(await mock.homeRuns(VAULT)).toEqual({ runs: [], truncated: false });
    expect(await mock.homeChanges(VAULT)).toBeNull();
    expect(await mock.installStarterKit(VAULT)).toEqual({ marker_saved: true });
    for (const { path, content } of mock.STARTER_FILES) expect(fs().get(path)).toBe(content);
    expect((await mock.scanVault(VAULT)).length).toBe(mock.STARTER_FILES.length);
    expect(await mock.starterMarker(VAULT)).toMatchObject({ kit: 1, outcome: 'added' });
    const before = new Map(fs());
    await expect(mock.installStarterKit(VAULT)).rejects.toThrow(
      'This vault was already offered the starter kit.',
    );
    await mock.declineStarterKit(VAULT);
    expect(fs()).toEqual(before);
  });
  it('refuses any existing page without changing bytes, in Rust’s words', async () => {
    fs().set('mine.md', '# Mine\n');
    const before = new Map(fs());
    const words = 'The starter kit goes only into an empty vault, and this one has pages.';
    expect(RUST).toContain(words);
    await expect(mock.installStarterKit(VAULT)).rejects.toThrow(words);
    expect(fs()).toEqual(before);
  });
  it('declines once without pages, and counts a marker without a recorded time', async () => {
    await mock.declineStarterKit(VAULT);
    expect([...fs().keys()]).toEqual(['.cerebro/starter.json']);
    fs().set('.cerebro/starter.json', '{"kit":1,"outcome":"declined"}');
    expect(await mock.starterMarker(VAULT)).toEqual({ kit: 1, outcome: 'declined' });
    await expect(mock.installStarterKit(VAULT)).rejects.toThrow('already offered');
  });
  it.each(['bad', '{}', 'null', '{"kit":1,"outcome":"maybe"}'])(
    'does not mistake an invalid marker for absence: %s',
    async (raw) => {
      fs().set('.cerebro/starter.json', raw);
      await expect(mock.starterMarker(VAULT)).rejects.toThrow('could not be read');
      await expect(mock.installStarterKit(VAULT)).rejects.toThrow('could not be read');
      await expect(mock.declineStarterKit(VAULT)).rejects.toThrow('could not be read');
      expect([...fs().values()]).toEqual([raw]);
    },
  );
  it('serializes simultaneous accepts so only one installs', async () => {
    const results = await Promise.allSettled([
      mock.installStarterKit(VAULT),
      mock.installStarterKit(VAULT),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect((await mock.scanVault(VAULT)).length).toBe(mock.STARTER_FILES.length);
  });
  it('ships a valid database, undated tasks, paused bounded agents, and resolving links', async () => {
    await mock.installStarterKit(VAULT);
    const entries = await mock.scanVault(VAULT);
    const schema = buildSchema(entries);
    const tasks = schema.types.get('Tasks')!;
    expect(tasks.folder).toBe('tasks');
    expect(tasks.deadline).toBe('due');
    expect(tasks.statuses.map((s) => s.id)).toEqual(['todo', 'progress', 'done']);
    expect(tasks.fields.find((field) => field.name === 'agent')).toMatchObject({
      kind: 'relation',
      target: 'Agent',
      limit: 1,
    });
    expect(tasks.views).toHaveLength(2);
    for (const view of tasks.views) expect(checkView(view, 'Tasks', schema, entries)).toEqual([]);
    const records = entries.filter((entry) => entry.type === 'Tasks');
    expect(records).toHaveLength(3);
    expect(
      records.every((entry) => entry.path.startsWith('tasks/') && !('due' in entry.properties)),
    ).toBe(true);
    const agents = entries.filter((entry) => entry.type === 'Agent');
    expect(agents).toHaveLength(2);
    for (const entry of agents) {
      expect(isPaused(entry)).toBe(true);
      expect(entry.properties.tools).toBe('safe');
      expect(parseScope(entry)?.length).toBe(1);
      const grant = agentRef(entry);
      for (const tool of grant.allowedTools!) expect(toolFacts(tool)).not.toBeNull();
      const held = grantedTools(grant.allowedTools);
      for (const tool of mentionedTools(await mock.readNote(VAULT, entry.path)))
        expect(held.has(tool)).toBe(true);
    }
    for (const entry of entries)
      for (const link of entry.outgoingLinks) expect(resolveTarget(link, entries)).not.toBeNull();
    for (const { path, content } of mock.STARTER_FILES) {
      expect(path).not.toMatch(/(^|\/)\.|^knowledge\//);
      for (const term of RETIRED.terms)
        expect(content.toLowerCase()).not.toContain(term.toLowerCase());
    }
  });
});
