// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOME_LANES } from '@/engine/homeLanes';
import { listSkills, skillPrompt } from '@/engine/skills';
import { grantedTools, mentionedTools } from '@/engine/toolGrant';
import { makeEntry } from '@/engine/testHelpers';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { TOOLS } from '@/lib/policy/tools';
import { emptyMockVault, resetMockFs, scanVault, STARTER_FILES } from './mockIpc';
import { addRecipes, missingRecipes, SHIPPED_RECIPES } from './recipes';
import RETIRED from '../../shared/prompt/retired-terms.json';

beforeEach(async () => {
  emptyMockVault();
  useUiStore.setState({ toasts: [] });
  await useVaultStore.getState().openVault('/demo-vault');
});
afterEach(() => {
  vi.restoreAllMocks();
  resetMockFs();
});

describe('shipped read-only recipes', () => {
  it('are editable skills with explicit read grants, inputs, no retired terms and no schedules', async () => {
    const files = (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
    for (const recipe of SHIPPED_RECIPES) files.set(recipe.path, recipe.bytes);
    const parsed = await scanVault('/demo-vault');
    const skills = listSkills(parsed);
    expect(skills.map((s) => s.name)).toEqual(['catch-me-up', 'what-i-did']);
    for (const skill of skills) {
      const recipe = SHIPPED_RECIPES.find((r) => r.path === skill.path)!;
      expect(STARTER_FILES.find((file) => file.path === recipe.path)?.content).toBe(recipe.bytes);
      expect(skill.description).not.toBe('');
      expect(skill.arguments).toHaveLength(1);
      expect(parsed.find((e) => e.path === recipe.path)?.properties.schedule).toBeUndefined();
      const held = grantedTools(skill.allowedTools);
      for (const tool of skill.allowedTools!) {
        expect(held.has(tool)).toBe(true);
        expect(TOOLS.tools.find((row) => row.name === tool)?.kind).toBe('read_only');
      }
      const prompt = skillPrompt(skill, recipe.bytes, '', {
        now: new Date('2026-07-28T12:00:00Z'),
        offsetMinutes: 420,
      });
      for (const tool of mentionedTools(prompt)) expect(held.has(tool)).toBe(true);
      for (const term of RETIRED.terms)
        expect(prompt.toLowerCase()).not.toContain(term.toLowerCase());
      expect(prompt).toContain('Write nothing and never rank');
    }
  });
  it('keeps Home’s visible lane order and names every unseen lane plus Done', () => {
    const body = SHIPPED_RECIPES.find((r) => r.slug === 'catch-me-up')!.bytes;
    const [read, unseen] = body.split("## What this can't see");
    const hidden = new Set(['proposals', 'reminders', 'changes']);
    const shown = HOME_LANES.filter((lane) => !hidden.has(lane.id));
    const positions = shown.map((lane) => read.indexOf(`**${lane.label}:**`));
    expect(positions.every((pos) => pos >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    for (const lane of HOME_LANES.filter((lane) => hidden.has(lane.id)))
      expect(unseen).toContain(lane.label);
    expect(unseen).toContain('What you marked Done');
  });
  it('preserves not-recorded days and names the three daily-history gaps', () => {
    const body = SHIPPED_RECIPES.find((r) => r.slug === 'what-i-did')!.bytes;
    expect(body).toContain('Cerebro was not open in this window');
    expect(body).toContain('"not recorded", never "nothing"');
    for (const gap of ['Edits outside Cerebro', 'Days Cerebro was closed', 'Pages you only read'])
      expect(body).toContain(gap);
    expect(body).toContain('cut-short');
  });
  it('counts an existing shipped path or declared Skill slug and leaves other pages alone', () => {
    const existing = makeEntry({ path: SHIPPED_RECIPES[0].path });
    expect(missingRecipes([existing]).map((r) => r.slug)).toEqual(['what-i-did']);
    const moved = makeEntry({
      path: 'mine/recap.md',
      type: 'Skill',
      properties: { slug: 'what-i-did' },
    });
    expect(missingRecipes([existing, moved])).toEqual([]);
    expect(missingRecipes([{ ...moved, type: null }])).toHaveLength(2);
  });
  it('adds missing bytes in one create-only batch and leaves an existing copy untouched', async () => {
    const map = (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
    map.set(SHIPPED_RECIPES[0].path, '# My version\n');
    await useVaultStore.getState().rescan();
    const batch = vi.spyOn(useVaultStore.getState(), 'applyBatch');
    expect(await addRecipes()).toBe(true);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0][0]).toEqual([
      { op: 'create', path: SHIPPED_RECIPES[1].path, content: SHIPPED_RECIPES[1].bytes },
    ]);
    expect(map.get(SHIPPED_RECIPES[0].path)).toBe('# My version\n');
    expect(await addRecipes()).toBe(true);
    expect(batch).toHaveBeenCalledTimes(1);
  });
  it('does not offer writes before a successful scan, and catches a failed write', async () => {
    useVaultStore.setState({ status: 'error' });
    expect(await addRecipes()).toBe(false);
    useVaultStore.setState({ status: 'ready' });
    vi.spyOn(useVaultStore.getState(), 'applyBatch').mockRejectedValueOnce(
      new Error('Disk unavailable'),
    );
    expect(await addRecipes()).toBe(false);
    expect(useUiStore.getState().toasts.at(-1)?.message).toBe('Disk unavailable');
  });
});
