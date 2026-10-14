// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Spy mode: every call still reaches the mock backend; a test overrides one.
vi.mock('@/lib/ipc', { spy: true });

import { docPagesFor } from '@/engine/docPages';
import { __resetOpenPages, registerFlush } from '@/editor/openPages';
import * as ipc from '@/lib/ipc';
import { resetMockFs } from '@/lib/mockIpc';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { addSubPage, nestPage } from './pageActions';

const VAULT = '/demo-vault';
const PLAN = 'notes/plan.md';
const PLAN_BYTES = '---\nstatus_note: keep me\n---\n# Plan\n\nSee [[loose]].\n';
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
const toasts = () => useUiStore.getState().toasts.map((t) => t.message);
const entryAt = (path: string) => useVaultStore.getState().entries.find((e) => e.path === path);

beforeEach(async () => {
  resetMockFs();
  vi.clearAllMocks();
  __resetOpenPages();
  window.localStorage.clear();
  useUiStore.setState({ toasts: [], favorites: {} });
  fs().set(PLAN, PLAN_BYTES);
  fs().set('notes/loose.md', '# Loose\n');
  await useVaultStore.getState().openVault(VAULT);
  useNavStore.setState({
    selection: { kind: 'doc', path: PLAN },
    history: [{ kind: 'doc', path: PLAN }],
    historyIndex: 0,
  });
});
afterEach(() => __resetOpenPages());

describe('addSubPage', () => {
  it('moves a plain page into its own folder, bytes untouched, and creates the child', async () => {
    useUiStore.getState().toggleFavorite(VAULT, PLAN);
    const child = await addSubPage(PLAN, 'Rollout checklist');
    expect(child).toBe('notes/plan/rollout-checklist.md');
    expect(fs().has(PLAN)).toBe(false);
    expect(fs().get('notes/plan/plan.md')).toBe(PLAN_BYTES);
    expect(fs().get('notes/plan/rollout-checklist.md')).toBe('# Rollout checklist\n');
    // History and Favorites follow the page to its new address.
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'notes/plan/plan.md' });
    expect(useUiStore.getState().favorites[VAULT]).toEqual(['notes/plan/plan.md']);
    // The store rescanned: the page now lists its child.
    const parent = entryAt('notes/plan/plan.md');
    expect(parent).toBeDefined();
    const pages = docPagesFor(parent!, useVaultStore.getState().entries);
    expect(pages?.pages.map((p) => p.path)).toEqual([
      'notes/plan/plan.md',
      'notes/plan/rollout-checklist.md',
    ]);
  });

  it('only creates on a page that already has a folder', async () => {
    fs().set('notes/doc/doc.md', '# Doc\n');
    await useVaultStore.getState().rescan();
    const child = await addSubPage('notes/doc/doc.md', 'Appendix');
    expect(child).toBe('notes/doc/appendix.md');
    expect(fs().get('notes/doc/doc.md')).toBe('# Doc\n');
    expect(vi.mocked(ipc.renameNote)).not.toHaveBeenCalled();
    expect(vi.mocked(ipc.createFolder)).not.toHaveBeenCalled();
  });

  it('lands a pending save before the rename', async () => {
    const order: string[] = [];
    registerFlush(async () => {
      order.push('flush');
      fs().set(PLAN, `${PLAN_BYTES}Typed a moment ago.\n`);
    });
    vi.mocked(ipc.renameNote).mockImplementationOnce(async (...args) => {
      order.push('rename');
      const mock = await vi.importActual<typeof import('@/lib/mockIpc')>('@/lib/mockIpc');
      return mock.renameNote(...args);
    });
    expect(await addSubPage(PLAN, 'Child')).not.toBeNull();
    expect(order).toEqual(['flush', 'rename']);
    expect(fs().get('notes/plan/plan.md')).toBe(`${PLAN_BYTES}Typed a moment ago.\n`);
  });

  it('refuses beside a same-name folder, toasts, and writes nothing', async () => {
    fs().set('notes/plan/other.md', '# Other\n');
    await useVaultStore.getState().rescan();
    const before = new Map(fs());
    expect(await addSubPage(PLAN, 'Child')).toBeNull();
    expect(
      toasts().some((m) => m.startsWith("Couldn't add sub-page") && m.includes('notes/plan/')),
    ).toBe(true);
    expect(new Map(fs())).toEqual(before);
  });

  it('refuses a page that cannot have sub-pages', async () => {
    const before = new Map(fs());
    expect(await addSubPage('knowledge/playbooks/warehouse-cutover.md', 'Child')).toBeNull();
    expect(toasts().some((m) => m.startsWith("Couldn't add sub-page"))).toBe(true);
    expect(new Map(fs())).toEqual(before);
  });

  it('refuses while the entries are another vault’s', async () => {
    useVaultStore.setState({ vaultPath: '/other-vault' });
    expect(await addSubPage(PLAN, 'Child')).toBeNull();
    expect(fs().get(PLAN)).toBe(PLAN_BYTES);
    expect(vi.mocked(ipc.renameNote)).not.toHaveBeenCalled();
    expect(toasts()).toContain('Not saved — the vault is still opening');
  });

  it('a failed rename toasts and rescans, and never throws', async () => {
    vi.mocked(ipc.renameNote).mockRejectedValueOnce(new Error('disk full'));
    const rescan = vi.spyOn(useVaultStore.getState(), 'rescan');
    await expect(addSubPage(PLAN, 'Child')).resolves.toBeNull();
    expect(toasts()).toContain("Couldn't add sub-page: disk full");
    expect(rescan).toHaveBeenCalled();
    expect(fs().get(PLAN)).toBe(PLAN_BYTES);
  });
});

describe('nestPage', () => {
  it('grows the target and moves the source under it', async () => {
    const moves = await nestPage('notes/loose.md', PLAN);
    expect(moves).toEqual([
      { from: PLAN, to: 'notes/plan/plan.md' },
      { from: 'notes/loose.md', to: 'notes/plan/loose.md' },
    ]);
    expect(fs().get('notes/plan/plan.md')).toBe(PLAN_BYTES);
    expect(fs().get('notes/plan/loose.md')).toBe('# Loose\n');
    expect(entryAt('notes/plan/loose.md')).toBeDefined();
  });

  it('refuses a drop into its own subtree and moves nothing', async () => {
    fs().set('notes/doc/doc.md', '# Doc\n');
    fs().set('notes/doc/child.md', '# Child\n');
    await useVaultStore.getState().rescan();
    const before = new Map(fs());
    expect(await nestPage('notes/doc', 'notes/doc/child.md')).toBeNull();
    expect(new Map(fs())).toEqual(before);
    expect(toasts().some((m) => m.startsWith("Couldn't add sub-page"))).toBe(true);
  });

  it('a failed move toasts and rescans, and never throws', async () => {
    vi.mocked(ipc.renameNote).mockRejectedValueOnce(new Error('disk full'));
    await expect(nestPage('notes/loose.md', PLAN)).resolves.toBeNull();
    expect(toasts()).toContain("Couldn't add sub-page: disk full");
  });
});
