// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentOwner } from '@/editor/documentOwner';
import {
  __resetOpenPages,
  registerFlush,
  registerHold,
  registerSaveParticipant,
} from '@/editor/openPages';
import * as ipc from '@/lib/ipc';
import { resetMockFs } from '@/lib/mockIpc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { savePageAsTemplate } from './templateActions';

vi.mock('@/lib/ipc', { spy: true });
const VAULT = '/demo-vault';
const PATH = 'notes/template-source.md';
const INITIAL = '---\nstatus_note: old\nfull_width: true\n---\n# Original\n\nOld body.\n';
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
const toasts = () => useUiStore.getState().toasts.map((toast) => toast.message);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  __resetOpenPages();
  vi.resetAllMocks();
  resetMockFs();
  fs().set(PATH, INITIAL);
  await useVaultStore.getState().openVault(VAULT);
  useUiStore.setState({ toasts: [] });
  vi.clearAllMocks();
});
afterEach(() => {
  __resetOpenPages();
  vi.resetAllMocks();
});

describe('savePageAsTemplate', () => {
  it('retains a failed real body and retries the same generation before copying', async () => {
    const key = { vaultId: VAULT, path: PATH, ownerId: 'template-source' };
    const owner = new DocumentOwner(key, '# Original\n\nOld body.\n', (body) =>
      ipc.saveNoteBody({ vault: VAULT, path: PATH, body }),
    );
    registerSaveParticipant({
      key,
      prepare: () => {},
      snapshot: () => owner.snapshot(),
      flush: () => owner.flush(),
    });
    owner.edit('# Revised\n\nRetained exact draft.\n');
    vi.mocked(ipc.saveNoteBody).mockRejectedValueOnce(new Error('disk refused'));
    expect(await savePageAsTemplate(VAULT, PATH)).toBeNull();
    expect(owner.snapshot().latestDraft).toBe('# Revised\n\nRetained exact draft.\n');
    expect(owner.snapshot().acknowledgedGeneration).toBe(0);
    expect(ipc.createNote).not.toHaveBeenCalled();
    const created = await savePageAsTemplate(VAULT, PATH);
    expect(created).toBe('templates/revised.md');
    expect(fs().get(created!)).toContain('Retained exact draft.');
    expect(owner.snapshot().generation).toBe(1);
    expect(owner.snapshot().acknowledgedGeneration).toBe(1);
  });

  it('captures a new buffered draft after folder creation and refuses the stale copy', async () => {
    const key = { vaultId: VAULT, path: PATH, ownerId: 'template-source' };
    let buffered = false;
    const owner = new DocumentOwner(key, '# Original\n\nOld body.\n', (body) =>
      ipc.saveNoteBody({ vault: VAULT, path: PATH, body }),
    );
    registerSaveParticipant({
      key,
      prepare: () => {
        if (buffered) owner.edit('# New buffer\n');
      },
      snapshot: () => owner.snapshot(),
      flush: () => owner.flush(),
    });
    vi.mocked(ipc.createFolder).mockImplementationOnce(async () => {
      buffered = true;
    });
    expect(await savePageAsTemplate(VAULT, PATH)).toBeNull();
    expect(ipc.createNote).not.toHaveBeenCalled();
    expect(owner.snapshot().latestDraft).toBe('# New buffer\n');
    expect(fs().get(PATH)).toBe(INITIAL);
  });

  it('copies the acknowledged body and metadata after preparation, not the old disk snapshot', async () => {
    registerFlush(async () => {
      fs().set(
        PATH,
        '---\nstatus_note: new\nfull_width: true\nproject: "[[Release]]"\n---\n# Current title\n\nLatest text.\n',
      );
    });
    const created = await savePageAsTemplate(VAULT, PATH);
    expect(created).toBe('templates/current-title.md');
    expect(fs().get(created!)).toContain('Latest text.');
    expect(fs().get(created!)).toContain('status_note: new');
    expect(fs().get(created!)).toContain('[[Release]]');
    expect(fs().get(created!)).not.toContain('full_width');
    expect(fs().get(created!)).toContain('# {{title}}');
  });

  it.each(['failed', 'held'] as const)('creates nothing while the source is %s', async (kind) => {
    if (kind === 'failed')
      registerFlush(async () => {
        throw new Error('disk refused');
      });
    else registerHold(() => PATH);
    const before = new Map(fs());
    expect(await savePageAsTemplate(VAULT, PATH)).toBeNull();
    expect(new Map(fs())).toEqual(before);
    expect(ipc.createFolder).not.toHaveBeenCalled();
    expect(ipc.createNote).not.toHaveBeenCalled();
    expect(toasts().some((message) => message.includes('Saved as template'))).toBe(false);
  });

  it.each([false, true])(
    'silences a failed flush after its vault retires (return=%s)',
    async (returnToOrigin) => {
      const gate = deferred<void>();
      const key = { vaultId: VAULT, path: PATH, ownerId: 'template-source' };
      const owner = new DocumentOwner(key, '# Original\n\nOld body.\n', (body) =>
        ipc.saveNoteBody({ vault: VAULT, path: PATH, body }),
      );
      registerSaveParticipant({
        key,
        prepare: () => {},
        snapshot: () => owner.snapshot(),
        flush: () => owner.flush(),
      });
      vi.mocked(ipc.saveNoteBody).mockImplementationOnce(async () => {
        await gate.promise;
        throw new Error('disk refused');
      });
      owner.edit('# Revised\n\nRetained exact draft.\n');
      const pending = savePageAsTemplate(VAULT, PATH);
      await vi.waitFor(() => expect(owner.snapshot().inFlightGeneration).toBe(1));
      useVaultStore.setState({ vaultPath: '/other', entriesVault: '/other' });
      if (returnToOrigin) useVaultStore.setState({ vaultPath: VAULT, entriesVault: VAULT });
      gate.resolve();
      expect(await pending).toBeNull();
      expect(owner.snapshot().failure?.kind).toBe('failed');
      expect(owner.snapshot().latestDraft).toBe('# Revised\n\nRetained exact draft.\n');
      expect(owner.snapshot().acknowledgedGeneration).toBe(0);
      expect(fs().get(PATH)).toBe(INITIAL);
      expect(ipc.createFolder).not.toHaveBeenCalled();
      expect(ipc.createNote).not.toHaveBeenCalled();
      expect(toasts()).toEqual([]);
    },
  );

  it.each([false, true])(
    'retires a copy when its vault changes during read (return=%s)',
    async (returnToOrigin) => {
      const gate = deferred<void>();
      const original = ipc.readNoteSource;
      vi.mocked(ipc.readNoteSource).mockImplementationOnce(async (...args) => {
        await gate.promise;
        return original(...args);
      });
      const pending = savePageAsTemplate(VAULT, PATH);
      await vi.waitFor(() => expect(ipc.readNoteSource).toHaveBeenCalled());
      useVaultStore.setState({ vaultPath: '/other', entriesVault: '/other' });
      if (returnToOrigin) useVaultStore.setState({ vaultPath: VAULT, entriesVault: VAULT });
      gate.resolve();
      expect(await pending).toBeNull();
      expect(ipc.createFolder).not.toHaveBeenCalled();
      expect(ipc.createNote).not.toHaveBeenCalled();
    },
  );

  it('does not create in the active vault after folder creation returns to another vault', async () => {
    vi.mocked(ipc.createFolder).mockImplementationOnce(async () => {
      useVaultStore.setState({ vaultPath: '/other', entriesVault: '/other' });
    });
    expect(await savePageAsTemplate(VAULT, PATH)).toBeNull();
    expect(ipc.createNote).not.toHaveBeenCalled();
  });

  it('refuses a source that changes between the metadata scan and exact body read', async () => {
    const original = ipc.readNoteSource;
    vi.mocked(ipc.readNoteSource).mockImplementationOnce(async (...args) => {
      fs().set(PATH, INITIAL.replace('status_note: old', 'status_note: outside'));
      return original(...args);
    });
    expect(await savePageAsTemplate(VAULT, PATH)).toBeNull();
    expect(ipc.createNote).not.toHaveBeenCalled();
  });

  it('replaces the actual title while keeping an earlier code example heading', async () => {
    fs().set(PATH, '```md\n# Example\n```\n\n# Actual title\n\nBody.\n');
    await useVaultStore.getState().rescan();
    const created = await savePageAsTemplate(VAULT, PATH);
    expect(fs().get(created!)).toContain('```md\n# Example\n```');
    expect(fs().get(created!)).toContain('\n# {{title}}\n');
    expect(fs().get(created!)).not.toContain('# Actual title');
  });

  it('does not claim success when the existing creation door fails', async () => {
    vi.mocked(ipc.createNote).mockRejectedValueOnce(new Error('cannot create'));
    expect(await savePageAsTemplate(VAULT, PATH)).toBeNull();
    expect(toasts()).toEqual(["Couldn't save template"]);
    expect(fs().get(PATH)).toBe(INITIAL);
  });
});
