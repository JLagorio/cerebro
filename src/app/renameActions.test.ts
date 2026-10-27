import { rememberLastPlace, readLastPlace } from './lastPlace';
import { useOpenLogStore } from '@/stores/openLogStore';
import * as pointers from './pointers';
import { navSeed } from '@/test/navSeed';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

vi.mock('@/lib/ipc', { spy: true });

import * as ipc from '@/lib/ipc';
import { resetMockFs } from '@/lib/mockIpc';
import { __resetOpenPages, registerFlush, registerHold } from '@/editor/openPages';
import { useNavStore } from '@/stores/navStore';
import { useRenamePromptStore } from '@/stores/renamePromptStore';
import { useUiStore } from '@/stores/uiStore';
import { useUndoStore } from '@/stores/undoStore';
import { useVaultStore } from '@/stores/vaultStore';
import { renameKeepingLinks } from './renameActions';

const VAULT = '/demo-vault';
const FROM = 'notes/rename-plan.md';
const TO = 'notes/rename-atlas.md';
const CITER = 'notes/rename-citer.md';
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
const messages = () => useUiStore.getState().toasts.map((row) => row.message);
const rename = () => renameKeepingLinks({ steps: [{ from: FROM, to: TO }], label: 'Renamed plan' });
const answer = async (accepted: boolean) => {
  await waitFor(() => expect(useRenamePromptStore.getState().pending).not.toBeNull());
  useRenamePromptStore.getState().answer(accepted);
};

beforeEach(async () => {
  resetMockFs();
  vi.clearAllMocks();
  __resetOpenPages();
  useRenamePromptStore.getState().cancel();
  useUiStore.setState({ toasts: [], favorites: {}, pendingRenames: {} });
  useOpenLogStore.setState({ logs: {}, saved: true });
  useUndoStore.getState().clear();
  fs().set(FROM, '# Rename plan\n');
  fs().set(
    CITER,
    '---\nrelated: "[[rename-plan]]"\n---\n\nSee [[ rename-plan#Notes |the plan]] and [[rename-plan]].\n',
  );
  await useVaultStore.getState().openVault(VAULT);
  useNavStore.setState({
    selection: { kind: 'doc', path: FROM },
    history: [navSeed({ kind: 'doc', path: FROM })],
    historyIndex: 0,
  });
});
afterEach(() => {
  if (vi.isMockFunction(pointers.followRename)) vi.mocked(pointers.followRename).mockRestore();
  __resetOpenPages();
  useRenamePromptStore.getState().cancel();
});

describe('renameKeepingLinks', () => {
  it('does not scan or move after a failed save report', async () => {
    registerFlush(async () => {
      throw new Error('disk full');
    });
    vi.mocked(ipc.scanVault).mockClear();
    expect(await rename()).toBeNull();
    expect(ipc.scanVault).not.toHaveBeenCalled();
    expect(ipc.applyBatch).not.toHaveBeenCalled();
    expect(fs().has(FROM)).toBe(true);
  });

  it('refuses a failed initial scan even when the cached snapshot has no citers', async () => {
    useVaultStore.setState({
      entries: useVaultStore.getState().entries.filter((entry) => entry.path !== CITER),
    });
    vi.mocked(ipc.scanVault).mockRejectedValueOnce(new Error('disk unavailable'));
    const before = new Map(fs());
    expect(await rename()).toBeNull();
    expect(new Map(fs())).toEqual(before);
    expect(ipc.renameNote).not.toHaveBeenCalled();
    expect(ipc.applyBatch).not.toHaveBeenCalled();
  });

  it('rechecks a no-prompt move after flushing and refuses a newly saved citer', async () => {
    fs().delete(CITER);
    let flushes = 0;
    registerFlush(async () => {
      if (++flushes === 2) fs().set(CITER, '# New citer\n\n[[rename-plan]]\n');
    });
    expect(await rename()).toBeNull();
    expect(fs().has(FROM)).toBe(true);
    expect(fs().has(TO)).toBe(false);
    expect(messages()).toContain(
      'A page changed while renaming, so nothing was renamed. Try again.',
    );
  });

  it('asks with exact counts and changes only link page parts in one batch', async () => {
    const before = fs().get(CITER)!;
    useUiStore.getState().toggleFavorite(VAULT, FROM);
    const task = rename();
    await waitFor(() =>
      expect(useRenamePromptStore.getState().pending?.pages).toEqual([
        { path: CITER, title: 'Rename citer', count: 3 },
      ]),
    );
    useRenamePromptStore.getState().answer(true);
    expect(await task).not.toBeNull();
    expect(fs().has(FROM)).toBe(false);
    expect(fs().get(TO)).toBe('# Rename plan\n');
    expect(fs().get(CITER)).toBe(before.replaceAll('rename-plan', 'rename-atlas'));
    expect(ipc.applyBatch).toHaveBeenCalledTimes(1);
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: TO });
    expect(useUiStore.getState().favorites[VAULT]).toEqual([TO]);
  });

  it('Cancel writes nothing', async () => {
    const before = new Map(fs());
    const task = rename();
    await answer(false);
    expect(await task).toBeNull();
    expect(new Map(fs())).toEqual(before);
    expect(ipc.applyBatch).not.toHaveBeenCalled();
  });

  it('retitles in the same batch and preserves frontmatter bytes and BOM', async () => {
    const original = '\uFEFF---\r\nstatus: "draft"\r\n---\r\n\r\n# Rename plan\r\n\r\nBody\r\n';
    fs().set(FROM, original);
    const task = renameKeepingLinks({
      steps: [{ from: FROM, to: TO }],
      retitle: { path: FROM, title: 'Rename atlas' },
      label: 'Renamed plan',
    });
    await answer(true);
    expect(await task).not.toBeNull();
    expect(fs().get(TO)).toBe(original.replace('# Rename plan', '# Rename atlas'));
    const ops = vi.mocked(ipc.applyBatch).mock.calls[0][1];
    expect(ops.map((op) => op.op)).toEqual(['replace_file', 'replace_file', 'rename']);
    expect(ipc.setNoteTitle).not.toHaveBeenCalled();
  });

  it('a title changed during confirmation refuses links and move together', async () => {
    const before = fs().get(CITER);
    const task = renameKeepingLinks({
      steps: [{ from: FROM, to: TO }],
      retitle: { path: FROM, title: 'Rename atlas' },
      label: 'Renamed plan',
    });
    await waitFor(() => expect(useRenamePromptStore.getState().pending).not.toBeNull());
    fs().set(FROM, '# A concurrent title\n');
    useRenamePromptStore.getState().answer(true);
    expect(await task).toBeNull();
    expect(fs().get(FROM)).toBe('# A concurrent title\n');
    expect(fs().get(CITER)).toBe(before);
    expect(fs().has(TO)).toBe(false);
  });

  it('a later no-prompt move collision leaves all earlier names alone', async () => {
    fs().delete(CITER);
    fs().set('notes/blocked.md', '# Taken\n');
    const before = new Map(fs());
    expect(
      await renameKeepingLinks({
        steps: [
          { from: FROM, to: TO },
          { from: TO, to: 'notes/blocked.md' },
        ],
        label: 'Renamed plan',
      }),
    ).toBeNull();
    expect(new Map(fs())).toEqual(before);
    expect(ipc.applyBatch).toHaveBeenCalledTimes(1);
  });

  it('a citer edited during confirmation refuses the entire batch', async () => {
    const task = rename();
    await waitFor(() => expect(useRenamePromptStore.getState().pending).not.toBeNull());
    fs().set(CITER, '# A newer edit\n');
    useRenamePromptStore.getState().answer(true);
    expect(await task).toBeNull();
    expect(fs().get(CITER)).toBe('# A newer edit\n');
    expect(fs().has(FROM)).toBe(true);
    expect(fs().has(TO)).toBe(false);
    expect(messages()).toContain(
      'A page changed while renaming, so nothing was renamed. Try again.',
    );
  });

  it('a plain move with no changing link needs no prompt', async () => {
    fs().delete(CITER);
    await useVaultStore.getState().rescan();
    expect(await rename()).not.toBeNull();
    expect(useRenamePromptStore.getState().pending).toBeNull();
    expect(ipc.renameNote).toHaveBeenCalledWith(VAULT, FROM, TO);
    expect(ipc.applyBatch).not.toHaveBeenCalled();
    expect(useUndoStore.getState().past).toEqual([]);
  });

  it('a title-only edit leaves existing title links alone', async () => {
    fs().set(CITER, '# Citer\n\n[[Rename plan]]\n');
    expect(
      await renameKeepingLinks({
        steps: [],
        retitle: { path: FROM, title: 'New title' },
        label: 'Retitled',
      }),
    ).not.toBeNull();
    expect(fs().get(FROM)).toBe('# New title\n');
    expect(fs().get(CITER)).toBe('# Citer\n\n[[Rename plan]]\n');
    expect(useRenamePromptStore.getState().pending).toBeNull();
  });

  it('refuses an escaped YAML target that raw spans cannot safely rewrite', async () => {
    fs().set(CITER, '---\nrelated: "[[rename-\\u0070lan]]"\n---\n\n[[rename-plan]]\n');
    const before = new Map(fs());
    expect(await rename()).toBeNull();
    expect(new Map(fs())).toEqual(before);
    expect(messages()).toContain(
      `Couldn't safely re-point links in ${CITER}, so nothing was renamed.`,
    );
  });

  it('a new citer during confirmation requires planning the rename again', async () => {
    const before = fs().get(CITER);
    const task = rename();
    await waitFor(() => expect(useRenamePromptStore.getState().pending).not.toBeNull());
    fs().set('notes/new-citer.md', '# New citer\n\n[[rename-plan]]\n');
    useRenamePromptStore.getState().answer(true);
    expect(await task).toBeNull();
    expect(fs().get(CITER)).toBe(before);
    expect(fs().has(FROM)).toBe(true);
    expect(messages()).toContain(
      'A page changed while renaming, so nothing was renamed. Try again.',
    );
  });

  it('flushes before planning so the latest links are included', async () => {
    let once = false;
    registerFlush(async () => {
      if (!once) fs().set(CITER, fs().get(CITER)! + 'Also [[rename-plan]].\n');
      once = true;
    });
    const task = rename();
    await waitFor(() => expect(useRenamePromptStore.getState().pending?.pages[0].count).toBe(4));
    useRenamePromptStore.getState().answer(true);
    expect(await task).not.toBeNull();
    expect(fs().get(CITER)).toContain('Also [[rename-atlas]]');
  });

  it('refuses a held save introduced while the confirmation is open', async () => {
    const task = rename();
    await waitFor(() => expect(useRenamePromptStore.getState().pending).not.toBeNull());
    registerHold(() => CITER);
    useRenamePromptStore.getState().answer(true);
    expect(await task).toBeNull();
    expect(fs().has(FROM)).toBe(true);
    expect(ipc.applyBatch).not.toHaveBeenCalled();
  });

  it('a vault switch while confirming writes neither vault', async () => {
    const before = new Map(fs());
    const task = rename();
    await waitFor(() => expect(useRenamePromptStore.getState().pending).not.toBeNull());
    useVaultStore.setState({ vaultPath: '/other-vault' });
    useRenamePromptStore.getState().answer(true);
    expect(await task).toBeNull();
    expect(new Map(fs())).toEqual(before);
  });

  it('read failures toast and never throw or rename', async () => {
    vi.mocked(ipc.readNoteSource).mockRejectedValueOnce(new Error('offline'));
    expect(await rename()).toBeNull();
    expect(fs().has(FROM)).toBe(true);
    expect(messages()).toContain(`Couldn't read ${CITER}, so nothing was renamed.`);
  });
});

describe('link-keeping rename Undo (M60.10b)', () => {
  it('Undo restores the path, title and every citer byte, and Redo mirrors it', async () => {
    const original = '\uFEFF---\r\nstatus: "draft"\r\n---\r\n\r\n# Rename plan\r\n\r\nBody\r\n';
    fs().set(FROM, original);
    const citer = fs().get(CITER);
    rememberLastPlace(VAULT, { kind: 'doc', path: FROM });
    useOpenLogStore.getState().record(VAULT, FROM);
    const followed = vi.spyOn(pointers, 'followRename');
    useUiStore.getState().toggleFavorite(VAULT, FROM);
    const task = renameKeepingLinks({
      steps: [{ from: FROM, to: TO }],
      retitle: { path: FROM, title: 'Rename atlas' },
      label: 'Rename plan',
    });
    await answer(true);
    expect(await task).not.toBeNull();
    const after = new Map(fs());
    const entry = useUndoStore.getState().past.at(-1)!;
    expect(entry.kind).toBe('rename');
    expect(useUiStore.getState().toasts.at(-1)?.action?.label).toBe('Undo');

    expect(await useUndoStore.getState().undoEntry(entry.id)).toBe(true);
    expect(fs().get(FROM)).toBe(original);
    expect(fs().has(TO)).toBe(false);
    expect(fs().get(CITER)).toBe(citer);
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: FROM });
    expect(useUiStore.getState().favorites[VAULT]).toEqual([FROM]);
    expect(readLastPlace(VAULT)).toEqual({ kind: 'doc', path: FROM });
    expect(useOpenLogStore.getState().logs[VAULT][0].path).toBe(FROM);
    expect(useUiStore.getState().toasts.at(-1)?.action?.label).toBe('Redo');

    expect(await useUndoStore.getState().redoEntry(entry.id)).toBe(true);
    expect(new Map(fs())).toEqual(after);
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: TO });
    expect(useUiStore.getState().favorites[VAULT]).toEqual([TO]);
    expect(readLastPlace(VAULT)).toEqual({ kind: 'doc', path: TO });
    expect(followed.mock.calls).toEqual([
      [VAULT, FROM, TO],
      [VAULT, TO, FROM],
      [VAULT, FROM, TO],
    ]);
    expect(useUiStore.getState().pendingRenames).toEqual({});
  });

  it('leaves an edited citer alone and names its recorded writer', async () => {
    const task = rename();
    await answer(true);
    await task;
    const changed = '# My newer note\n\n[[rename-atlas]]\n';
    fs().set(CITER, changed);
    vi.mocked(ipc.pageAttribution).mockResolvedValueOnce({
      state: 'recorded',
      kind: 'vault.write',
      actor: 'human:me',
      run_id: null,
      approved_by: null,
      at: new Date(Date.now() + 1000).toISOString(),
    });
    expect(await useUndoStore.getState().undo()).toBe(true);
    expect(fs().get(FROM)).toBe('# Rename plan\n');
    expect(fs().get(CITER)).toBe(changed);
    expect(messages().at(-1)).toContain('“My newer note” (you)');
    expect(await useUndoStore.getState().redo()).toBe(true);
    expect(fs().get(CITER)).toBe(changed);
  });

  it.each(['occupied', 'moved again'])(
    '%s refuses the whole Undo before citers or anchors change',
    async (conflict) => {
      const concept = 'knowledge/concepts/rename-anchor.md';
      fs().set(concept, '---\ntitle: Anchor\nabout: "[[rename-plan]]"\n---\n\n[[rename-plan]]\n');
      const task = rename();
      await answer(true);
      await task;
      if (conflict === 'occupied') fs().set(FROM, '# Another page\n');
      else {
        fs().set('notes/moved-again.md', fs().get(TO)!);
        fs().delete(TO);
      }
      const before = new Map(fs());
      vi.mocked(ipc.updateFrontmatter).mockClear();
      expect(await useUndoStore.getState().undo()).toBe(false);
      expect(new Map(fs())).toEqual(before);
      expect(ipc.updateFrontmatter).not.toHaveBeenCalled();
      expect(useUndoStore.getState().past).toEqual([]);
      expect(useUndoStore.getState().future).toEqual([]);
      expect(messages().at(-1)).toContain('Nothing was undone');
    },
  );

  it('re-points concept anchors through the valve while never restoring knowledge bytes', async () => {
    const concept = 'knowledge/concepts/rename-anchor.md';
    fs().set(concept, '---\ntitle: Anchor\nabout: "[[rename-plan]]"\n---\n\n[[rename-plan]]\n');
    const task = rename();
    await answer(true);
    await task;
    expect(ipc.updateFrontmatter).toHaveBeenLastCalledWith(VAULT, concept, {
      about: '[[rename-atlas]]',
    });
    fs().set(concept, fs().get(concept)! + '\nNew evidence remains.\n');
    expect(await useUndoStore.getState().undo()).toBe(true);
    expect(ipc.updateFrontmatter).toHaveBeenLastCalledWith(VAULT, concept, {
      about: '[[rename-plan]]',
    });
    expect(fs().get(concept)).toContain('New evidence remains.');
    expect(await useUndoStore.getState().redo()).toBe(true);
    expect(ipc.updateFrontmatter).toHaveBeenLastCalledWith(VAULT, concept, {
      about: '[[rename-atlas]]',
    });
    expect(fs().get(concept)).toContain('New evidence remains.');
    expect(
      vi
        .mocked(ipc.applyBatch)
        .mock.calls.flatMap(([, ops]) => ops)
        .some((op) => op.op !== 'rename' && op.path.startsWith('knowledge/')),
    ).toBe(false);
  });

  it('reverses folder then main-file steps in reverse order', async () => {
    fs().delete(FROM);
    const old = 'notes/rename-plan/rename-plan.md';
    const next = 'notes/rename-atlas/rename-atlas.md';
    fs().set(old, '# Rename plan\n');
    const citer = fs().get(CITER);
    const task = renameKeepingLinks({
      steps: [
        { from: 'notes/rename-plan', to: 'notes/rename-atlas' },
        { from: 'notes/rename-atlas/rename-plan.md', to: next },
      ],
      retitle: { path: old, title: 'Rename atlas' },
      label: 'Rename plan',
    });
    await answer(true);
    expect(await task).not.toBeNull();
    expect(await useUndoStore.getState().undo()).toBe(true);
    expect(fs().get(old)).toBe('# Rename plan\n');
    expect(fs().has(next)).toBe(false);
    expect(fs().get(CITER)).toBe(citer);
    expect(await useUndoStore.getState().redo()).toBe(true);
    expect(fs().get(next)).toBe('# Rename atlas\n');
    expect(fs().has(old)).toBe(false);
  });

  it('an unavailable citer read retains Undo without writing', async () => {
    const task = rename();
    await answer(true);
    await task;
    const before = new Map(fs());
    vi.mocked(ipc.readNoteSource).mockRejectedValueOnce(new Error('offline'));
    expect(await useUndoStore.getState().undo()).toBe(false);
    expect(new Map(fs())).toEqual(before);
    expect(useUndoStore.getState().past).toHaveLength(1);
    expect(messages().at(-1)).toBe(`Couldn't read ${CITER}, so nothing was undone.`);
  });
});

describe('rename rails (CV-41)', () => {
  // Read source bytes without a ?raw module: Vitest's coverage cache strips
  // query strings, so a raw transform can replace the executable source map.
  const root = join(__dirname, '..');
  const appSources = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((path) => /\.tsx?$/.test(path) && !/\.(test|spec)\./.test(path))
    .map((path) => {
      const file = join(root, path);
      const local = relative(__dirname, file).replaceAll('\\', '/');
      return [local.startsWith('.') ? local : `./${local}`, readFileSync(file, 'utf8')] as const;
    });

  it('only renameActions renames a file', () => {
    for (const [path, source] of appSources) {
      if (path === './renameActions.ts') continue;
      expect(source, path).not.toMatch(
        /import\s+[^;]*\brenameNote\b[^;]*from\s+['"]@\/lib\/ipc['"]/,
      );
    }
  });

  it('no module writes a title link', () => {
    for (const [path, source] of appSources)
      expect(source, path).not.toMatch(/\[\[\$\{[^}]*\btitle\b[^}]*\}/);
  });
});

it('a whiteboard citer is never read or written and its page can still rename', async () => {
  fs().delete(CITER);
  const board = 'boards/citer.canvas';
  const bytes = JSON.stringify({
    nodes: [{ id: 'a', type: 'file', x: 0, y: 0, width: 100, height: 100, file: FROM }],
    edges: [],
  });
  fs().set(board, bytes);
  const pending = rename();
  await waitFor(() => expect(useRenamePromptStore.getState().pending).not.toBeNull());
  expect(useRenamePromptStore.getState().pending).toMatchObject({
    fromPath: FROM,
    sources: [{ path: board, board: true }],
  });
  expect(vi.mocked(ipc.readNoteSource).mock.calls.some((call) => call[1] === board)).toBe(false);
  useRenamePromptStore.getState().answer(true);
  expect(await pending).not.toBeNull();
  expect(fs().has(TO)).toBe(true);
  expect(fs().get(board)).toBe(bytes);
  expect(vi.mocked(ipc.applyBatch).mock.calls.flatMap(([, ops]) => ops)).toEqual([
    { op: 'rename', from: FROM, to: TO },
  ]);
});
