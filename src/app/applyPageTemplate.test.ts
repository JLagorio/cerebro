// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DocumentOwner } from '@/editor/documentOwner';
import { __resetOpenPages, registerSaveParticipant } from '@/editor/openPages';
import * as ipc from '@/lib/ipc';
import * as mock from '@/lib/mockIpc';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { applyPageTemplate } from './applyPageTemplate';

vi.mock('@/lib/ipc', { spy: true });
const VAULT = '/demo-vault';
const PATH = 'notes/blank-template-target.md';
const TEMPLATE = 'templates/test-selected.md';
const BEFORE = '---\nstatus_note: existing\n---\n# Target\n\n';
const SOURCE =
  '---\nstatus_note: chosen\nrelated: "[[Ada]]"\nfill: Private instruction\n---\n# {{title}}\n\nSelected scaffold.\n';
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;

beforeEach(async () => {
  __resetOpenPages();
  vi.resetAllMocks();
  mock.resetMockFs();
  fs().set(PATH, BEFORE);
  fs().set(TEMPLATE, SOURCE);
  await useVaultStore.getState().openVault(VAULT);
  useUiStore.setState({ toasts: [] });
  vi.clearAllMocks();
});
afterEach(() => {
  __resetOpenPages();
  vi.resetAllMocks();
});

function registerOwner() {
  const owner = new DocumentOwner(
    { vaultId: VAULT, path: PATH, ownerId: 'template-target' },
    '# Target\n\n',
    (body) => ipc.saveNoteBody({ vault: VAULT, path: PATH, body }),
  );
  registerSaveParticipant({
    key: owner.key,
    prepare: () => {},
    snapshot: () => owner.snapshot(),
    flush: () => owner.flush(),
  });
  return owner;
}

it('applies body and metadata together with the checked target hash', async () => {
  const hash = (await ipc.readNoteSource(VAULT, PATH)).hash;
  expect(await applyPageTemplate(VAULT, PATH, TEMPLATE)).toBe(true);
  expect(ipc.applyBatch).toHaveBeenCalledOnce();
  const ops = vi.mocked(ipc.applyBatch).mock.calls[0][1];
  expect(ops).toEqual([
    { op: 'body', path: PATH, body: '# Target\n\nSelected scaffold.\n', expectHash: hash },
    {
      op: 'patch',
      path: PATH,
      set: { status_note: 'chosen', related: ['[[Ada]]'] },
      expectHash: hash,
    },
  ]);
  expect(fs().get(PATH)).toContain('Selected scaffold.');
  expect(fs().get(PATH)).toContain('status_note: chosen');
  expect(fs().get(PATH)).not.toContain('Private instruction');
});

it('keeps both parts untouched on refusal and retries the same chosen template', async () => {
  vi.mocked(ipc.applyBatch).mockRejectedValueOnce(Error('disk full'));
  expect(await applyPageTemplate(VAULT, PATH, TEMPLATE)).toBe(false);
  expect(fs().get(PATH)).toBe(BEFORE);
  expect(await applyPageTemplate(VAULT, PATH, TEMPLATE)).toBe(true);
  expect(fs().get(PATH)).toContain('Selected scaffold.');
  expect(fs().get(PATH)).toContain('status_note: chosen');
});

it('keeps a failed retained body and never replaces it with the template', async () => {
  const owner = registerOwner();
  owner.edit('# Target\n\nMy unsaved work.\n');
  vi.mocked(ipc.saveNoteBody).mockRejectedValueOnce(Error('disk full'));
  expect(await applyPageTemplate(VAULT, PATH, TEMPLATE)).toBe(false);
  expect(owner.snapshot().latestDraft).toContain('My unsaved work.');
  expect(owner.snapshot().acknowledgedGeneration).toBe(0);
  expect(ipc.saveNoteBody).toHaveBeenCalledOnce();
  expect(ipc.applyBatch).not.toHaveBeenCalled();
  expect(fs().get(PATH)).toBe(BEFORE);
});

it('saves a newer body, then refuses because the acknowledged page is no longer blank', async () => {
  const owner = registerOwner();
  owner.edit('# Target\n\nMy saved work.\n');
  expect(await applyPageTemplate(VAULT, PATH, TEMPLATE)).toBe(false);
  expect(owner.snapshot().acknowledgedGeneration).toBe(1);
  expect(fs().get(PATH)).toContain('My saved work.');
  expect(ipc.applyBatch).not.toHaveBeenCalled();
});

it.each(['target', 'template'] as const)(
  'refuses mismatched scan/read versions for the %s',
  async (changed) => {
    vi.mocked(ipc.readNoteSource).mockImplementation(async (vault, path) => {
      if (path === (changed === 'target' ? PATH : TEMPLATE))
        fs().set(path, '# Different content\n\nChanged outside.\n');
      return mock.readNoteSource(vault, path);
    });
    expect(await applyPageTemplate(VAULT, PATH, TEMPLATE)).toBe(false);
    expect(ipc.applyBatch).not.toHaveBeenCalled();
  },
);

it.each(['round-trip', 'retired'] as const)(
  'does not dispatch after the action origin is %s',
  async (reason) => {
    let current = true;
    vi.mocked(ipc.readNoteSource).mockImplementation(async (vault, path) => {
      if (reason === 'round-trip') {
        useVaultStore.setState({ vaultPath: '/other' });
        useVaultStore.setState({ vaultPath: VAULT });
      } else current = false;
      return mock.readNoteSource(vault, path);
    });
    expect(await applyPageTemplate(VAULT, PATH, TEMPLATE, () => current)).toBe(false);
    expect(ipc.applyBatch).not.toHaveBeenCalled();
    expect(fs().get(PATH)).toBe(BEFORE);
    expect(useUiStore.getState().toasts).toEqual([]);
  },
);

it('never recreates a target that disappeared before applying', async () => {
  fs().delete(PATH);
  expect(await applyPageTemplate(VAULT, PATH, TEMPLATE)).toBe(false);
  expect(fs().has(PATH)).toBe(false);
  expect(ipc.applyBatch).not.toHaveBeenCalled();
});

it('preserves a newer draft typed while the selected template is being read', async () => {
  const owner = registerOwner();
  vi.mocked(ipc.readNoteSource).mockImplementation(async (vault, path) => {
    if (path === TEMPLATE) owner.edit('# Target\n\nTyped during template lookup.\n');
    return mock.readNoteSource(vault, path);
  });
  expect(await applyPageTemplate(VAULT, PATH, TEMPLATE)).toBe(false);
  expect(ipc.applyBatch).not.toHaveBeenCalled();
  expect(owner.snapshot()).toMatchObject({
    latestDraft: '# Target\n\nTyped during template lookup.\n',
    acknowledgedGeneration: 0,
  });
  expect(fs().get(PATH)).toBe(BEFORE);
});

it('lets the existing batch guard refuse an outside edit after lookup', async () => {
  vi.mocked(ipc.applyBatch).mockImplementationOnce(async (vault, ops) => {
    fs().set(PATH, '# Written outside\n\nKeep every byte.\n');
    return mock.applyBatch(vault, ops);
  });
  expect(await applyPageTemplate(VAULT, PATH, TEMPLATE)).toBe(false);
  expect(fs().get(PATH)).toBe('# Written outside\n\nKeep every byte.\n');
});
