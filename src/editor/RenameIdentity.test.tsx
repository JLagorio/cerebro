// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
vi.mock('@/lib/ipc', { spy: true });
import * as ipc from '@/lib/ipc';
import * as mock from '@/lib/mockIpc';
import { renameKeepingLinks } from '@/app/renameActions';
import { navSeed } from '@/test/navSeed';
import { PaneContext, useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { useRenamePromptStore } from '@/stores/renamePromptStore';
import { useUndoStore } from '@/stores/undoStore';
import { useUiStore } from '@/stores/uiStore';
import { useCanvasFile, type CanvasFile } from '@/whiteboard/useCanvasFile';
import { useDiagramFile, type DiagramFile } from '@/mermaid/useDiagramFile';
import { useFieldSaveParticipant } from './useFieldSaveParticipant';
import type { EditorReadyInfo } from './MarkdownEditor';
import { registerSheetDraft } from '@/sheet/pendingSheets';
import { FocusedFieldInput } from './FocusedFieldInput';
import { DeletedDraftRecovery } from './DeletedDraftRecoveryFace';
import { NoteBodyEditor } from './NoteBodyEditor';
import {
  __resetOpenPages,
  retainedDocumentOwner,
  flushOpenPages,
  registerSaveParticipant,
  retainDocumentOwner,
  documentPresentationOf,
  retainedSaveParticipant,
} from './openPages';
import { DocumentOwner } from './documentOwner';
import { FieldSaveParticipant } from './fieldSaveParticipant';
import { recoveryDrafts, registerRecovery, discardRecovery } from './deletedDraftRecovery';

const VAULT = '/demo-vault';
const FROM = 'inbox/identity-before.md';
const TO = 'inbox/identity-after.md';
const RAW = '\ufeff---\r\nstatus: "draft"\r\n---\r\n\r\n# Identity\r\n\r\nExact body 😀\r\n';
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
let richReady: EditorReadyInfo | null = null;
function LiveNote() {
  const selection = useNavStore((s) => s.selection);
  return selection.kind === 'doc' ? (
    <PaneContext.Provider value="p93">
      <NoteBodyEditor
        key={selection.path}
        path={selection.path}
        debounceMs={60_000}
        onReady={(info) => {
          richReady = info;
        }}
      />
    </PaneContext.Provider>
  ) : null;
}
beforeAll(async () => {
  await import('./MarkdownEditor');
}, 30_000);
beforeEach(async () => {
  __resetOpenPages();
  richReady = null;
  vi.clearAllMocks();
  mock.resetMockFs();
  fs().set(FROM, RAW);
  await useVaultStore.getState().openVault(VAULT);
  useNavStore.setState({
    active: 'p93',
    paneIds: ['p93'],
    focusOrder: ['p93'],
    stashed: {},
    selection: { kind: 'doc', path: FROM },
    history: [navSeed({ kind: 'doc', path: FROM })],
    historyIndex: 0,
  });
  useUiStore.setState({ pendingRenames: {}, toasts: [] });
});
afterEach(() => {
  cleanup();
  __resetOpenPages();
  vi.restoreAllMocks();
  useRenamePromptStore.getState().cancel();
});
const rename = () =>
  renameKeepingLinks({ steps: [{ from: FROM, to: TO }], label: 'Renamed identity' });
const key = (path: string) => ({ vaultId: VAULT, path, ownerId: 'p93' });
async function source() {
  render(<LiveNote />);
  const toggle = await screen.findByRole('button', { name: 'Source' });
  await waitFor(() => expect(toggle).toHaveProperty('disabled', false));
  fireEvent.click(toggle);
  return screen.findByRole('textbox', { name: 'Page source' });
}

it('moves a settled source owner and its presentation before the replacement mounts', async () => {
  await source();
  const owner = retainedDocumentOwner(key(FROM));
  expect(owner).toBeDefined();
  await act(async () => {
    expect(await rename()).not.toBeNull();
  });
  expect(fs().get(TO)).toBe(RAW);
  expect(fs().has(FROM)).toBe(false);
  expect(retainedDocumentOwner(key(TO))).toBe(owner);
  expect(retainedDocumentOwner(key(FROM))).toBeUndefined();
  expect(await screen.findByRole('textbox', { name: 'Page source' })).toHaveProperty(
    'value',
    '\n# Identity\n\nExact body 😀\n',
  );
});

it('holds exact source typed during native rename and never recreates the old path', async () => {
  const input = await source();
  const owner = retainedDocumentOwner(key(FROM))!;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const renameNative = vi
    .spyOn(ipc, 'renameNote')
    .mockImplementationOnce(async (vault, from, to) => {
      await gate;
      return mock.renameNote(vault, from, to);
    });
  let pending!: ReturnType<typeof rename>;
  await act(async () => {
    pending = rename();
  });
  await waitFor(() => expect(renameNative).toHaveBeenCalled());
  fireEvent.change(input, { target: { value: '\n# Identity\n\nLate exact 😀\n' } });
  await act(async () => {
    const report = await flushOpenPages();
    expect(report.unresolvedOwnerIds.length).toBeGreaterThan(0);
  });
  expect(fs().get(FROM)).toBe(RAW);
  await act(async () => {
    release();
    await pending;
  });
  const moved = retainedDocumentOwner(key(TO));
  expect(moved).toBe(owner);
  expect(moved!.snapshot().latestDraft).toBe('\r\n# Identity\r\n\r\nLate exact 😀\r\n');
  expect(recoveryDrafts(key(FROM))).toEqual([]);
  expect(fs().has(FROM)).toBe(false);
  await screen.findByRole('textbox', { name: 'Page source' });
  await act(() => flushOpenPages());
  expect(fs().get(TO)).toBe(RAW.replace('Exact body 😀', 'Late exact 😀'));
  expect(fs().has(FROM)).toBe(false);
});

let canvas: CanvasFile = { state: 'loading' };
let diagram: DiagramFile | null = null;
function BoardHook({ path }: { path: string }) {
  const value = useCanvasFile(path);
  useLayoutEffect(() => {
    canvas = value;
  });
  return null;
}
function DiagramHook({ path }: { path: string }) {
  const value = useDiagramFile(path);
  useLayoutEffect(() => {
    diagram = value;
  });
  return null;
}
function LiveBoard({ kind }: { kind: 'canvas' | 'diagram' }) {
  const selected = useNavStore((s) => s.selection);
  if (selected.kind !== 'diagram') return null;
  return (
    <PaneContext.Provider value="p93">
      {kind === 'canvas' ? (
        <BoardHook key={selected.path} path={selected.path} />
      ) : (
        <DiagramHook key={selected.path} path={selected.path} />
      )}
    </PaneContext.Provider>
  );
}
async function seedBoard(kind: 'canvas' | 'diagram') {
  const from = `boards/identity-before.${kind === 'canvas' ? 'canvas' : 'mmd'}`;
  const to = `boards/identity-after.${kind === 'canvas' ? 'canvas' : 'mmd'}`;
  fs().set(
    from,
    kind === 'canvas'
      ? JSON.stringify({
          nodes: [{ id: 'a', type: 'text', text: 'Card', x: 0, y: 0, width: 100, height: 60 }],
          edges: [],
          unknown: 'keep',
        })
      : 'graph TD\r\n A-->B\r\n',
  );
  await useVaultStore.getState().rescan();
  useNavStore.setState({
    selection: { kind: 'diagram', path: from },
    history: [navSeed({ kind: 'diagram', path: from })],
    historyIndex: 0,
  });
  render(<LiveBoard kind={kind} />);
  await waitFor(() =>
    expect(kind === 'canvas' ? canvas.state : diagram?.code !== null).toBe(
      kind === 'canvas' ? 'ready' : true,
    ),
  );
  return { from, to };
}
it.each(['canvas', 'diagram'] as const)(
  '%s transfers the live owner with an edit made during actual rename IPC',
  async (kind) => {
    const { from, to } = await seedBoard(kind);
    const scene = canvas.state === 'ready' ? canvas.editor : null;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const native = vi.spyOn(ipc, 'renameNote').mockImplementationOnce(async (vault, old, next) => {
      await gate;
      return mock.renameNote(vault, old, next);
    });
    let pending!: ReturnType<typeof renameKeepingLinks>;
    await act(async () => {
      pending = renameKeepingLinks({ steps: [{ from, to }], label: 'Renamed board' });
    });
    await waitFor(() => expect(native).toHaveBeenCalled());
    act(() => {
      if (kind === 'diagram') diagram!.handleChange('graph TD\r\n Late-->Exact\r\n');
      else {
        scene!.begin('Move');
        scene!.preview(new Map([['n:a', { ...scene!.board.nodes.get('a')!, x: 42 }]]));
        scene!.commit();
      }
    });
    try {
      await act(async () => {
        expect((await flushOpenPages()).unresolvedOwnerIds.length).toBeGreaterThan(0);
      });
    } finally {
      await act(async () => {
        release();
        await pending;
      });
    }
    expect(fs().has(from)).toBe(false);
    if (kind === 'canvas')
      await waitFor(() => {
        expect(canvas.state).toBe('ready');
        if (canvas.state === 'ready') {
          expect(canvas.editor).toBe(scene);
          expect(canvas.editor.board.nodes.get('a')!.x).toBe(42);
        }
      });
    else await waitFor(() => expect(diagram!.code).toBe('graph TD\r\n Late-->Exact\r\n'));
    await act(() => flushOpenPages());
    expect(fs().has(from)).toBe(false);
    if (kind === 'canvas') {
      expect(JSON.parse(fs().get(to)!).nodes[0].x).toBe(42);
      expect(JSON.parse(fs().get(to)!).unknown).toBe('keep');
    } else expect(fs().get(to)).toBe('graph TD\r\n Late-->Exact\r\n');
  },
);

let field: Extract<ReturnType<typeof useFieldSaveParticipant>, { kind: 'ready' }> | null = null;
function FieldHook({ path }: { path: string }) {
  const value = useFieldSaveParticipant(
    { vaultId: VAULT, path, ownerId: 'field:status' },
    'draft',
    (text) => ({ ok: true, value: text }),
    async (value) => {
      await ipc.updateFrontmatter(VAULT, path, { status: value });
      return true;
    },
  );
  useLayoutEffect(() => {
    field = value.kind === 'ready' ? value : null;
  });
  return null;
}
function LiveField() {
  const selected = useNavStore((s) => s.selection);
  return selected.kind === 'doc' ? <FieldHook key={selected.path} path={selected.path} /> : null;
}
it('retains a field edited during rename and rebinds its guarded writer on destination attachment', async () => {
  render(<LiveField />);
  const owner = field!.owner;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const native = vi.spyOn(ipc, 'renameNote').mockImplementationOnce(async (vault, old, next) => {
    await gate;
    return mock.renameNote(vault, old, next);
  });
  let pending!: ReturnType<typeof rename>;
  await act(async () => {
    pending = rename();
  });
  await waitFor(() => expect(native).toHaveBeenCalled());
  act(() => field!.owner.edit('late exact status 😀'));
  try {
    await act(async () => {
      expect((await flushOpenPages()).unresolvedOwnerIds.length).toBeGreaterThan(0);
    });
  } finally {
    await act(async () => {
      release();
      await pending;
    });
  }
  expect(field!.owner).toBe(owner);
  expect(field!.state.latestDraft).toBe('late exact status 😀');
  await act(() => flushOpenPages());
  expect(fs().get(TO)).toContain('late exact status 😀');
  expect(fs().has(FROM)).toBe(false);
});

it('moves folder descendants with source presentation through batch receipt, Undo and Redo', async () => {
  const old = 'notes/transfer-folder/unique-transfer.md';
  const next = 'notes/renamed-folder/unique-transfer-renamed.md';
  fs().set(old, RAW);
  fs().set('notes/identity-citer.md', '# Citer\n\n[[unique-transfer]]\n');
  await useVaultStore.getState().rescan();
  useUndoStore.getState().clear();
  useNavStore.setState({
    selection: { kind: 'doc', path: old },
    history: [navSeed({ kind: 'doc', path: old })],
    historyIndex: 0,
  });
  await source();
  const owner = retainedDocumentOwner(key(old));
  let pending!: ReturnType<typeof renameKeepingLinks>;
  await act(async () => {
    pending = renameKeepingLinks({
      steps: [
        { from: 'notes/transfer-folder', to: 'notes/renamed-folder' },
        { from: 'notes/renamed-folder/unique-transfer.md', to: next },
      ],
      retitle: { path: old, title: 'Moved identity' },
      label: 'Moved folder',
    });
  });
  await waitFor(() => expect(useRenamePromptStore.getState().pending).not.toBeNull());
  await act(async () => {
    useRenamePromptStore.getState().answer(true);
    await pending;
  });
  await waitFor(() =>
    expect(screen.getByRole('textbox', { name: 'Page source' })).toHaveProperty(
      'value',
      '\n# Moved identity\n\nExact body 😀\n',
    ),
  );
  expect(retainedDocumentOwner(key(next))).toBe(owner);
  expect(fs().get(next)).toBe(RAW.replace('# Identity', '# Moved identity'));
  const entry = useUndoStore.getState().past.at(-1)!;
  await act(async () => {
    expect(await useUndoStore.getState().undoEntry(entry.id)).toBe(true);
  });
  await waitFor(() =>
    expect(screen.getByRole('textbox', { name: 'Page source' })).toHaveProperty(
      'value',
      '\n# Identity\n\nExact body 😀\n',
    ),
  );
  expect(retainedDocumentOwner(key(old))).toBe(owner);
  expect(fs().get(old)).toBe(RAW);
  await act(async () => {
    expect(await useUndoStore.getState().redoEntry(entry.id)).toBe(true);
  });
  await waitFor(() =>
    expect(screen.getByRole('textbox', { name: 'Page source' })).toHaveProperty(
      'value',
      '\n# Moved identity\n\nExact body 😀\n',
    ),
  );
  expect(retainedDocumentOwner(key(next))).toBe(owner);
  expect(fs().has(old)).toBe(false);
});

it('releases a refused native move without migrating the owner or losing late source', async () => {
  const input = await source();
  const owner = retainedDocumentOwner(key(FROM));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const native = vi.spyOn(ipc, 'renameNote').mockImplementationOnce(async () => {
    await gate;
    throw new Error('native refused');
  });
  let pending!: ReturnType<typeof rename>;
  await act(async () => {
    pending = rename();
  });
  await waitFor(() => expect(native).toHaveBeenCalled());
  fireEvent.change(input, { target: { value: '\n# Identity\n\nKept on refusal 😀\n' } });
  await act(async () => {
    release();
    expect(await pending).toBeNull();
  });
  expect(retainedDocumentOwner(key(FROM))).toBe(owner);
  expect(retainedDocumentOwner(key(TO))).toBeUndefined();
  await act(() => flushOpenPages());
  expect(fs().get(FROM)).toBe(RAW.replace('Exact body 😀', 'Kept on refusal 😀'));
  expect(fs().has(TO)).toBe(false);
});

it('refuses a moved custom owner without a writer-rebinding adapter', async () => {
  const state = {
    latestDraft: 'saved',
    generation: 0,
    acknowledgedGeneration: 0,
    inFlightGeneration: null,
    failure: null,
  };
  registerSaveParticipant({
    key: { vaultId: VAULT, path: FROM, ownerId: 'custom' },
    prepare: () => {},
    snapshot: () => state,
    flush: async () => ({ kind: 'clean', ownerId: 'custom', generation: 0 }),
  });
  expect(await rename()).toBeNull();
  expect(fs().get(FROM)).toBe(RAW);
  expect(fs().has(TO)).toBe(false);
});

it('keeps another vault owner with the same path isolated from the landed rename', async () => {
  const other = retainDocumentOwner(
    { vaultId: '/other-vault', path: FROM, ownerId: 'p93' },
    'other bytes',
    async () => ({ kind: 'file', contentHash: 'other' }),
  );
  await source();
  await act(async () => {
    expect(await rename()).not.toBeNull();
  });
  expect(retainedDocumentOwner({ vaultId: '/other-vault', path: FROM, ownerId: 'p93' })).toBe(
    other,
  );
  expect(other.snapshot().latestDraft).toBe('other bytes');
  expect(other.key.path).toBe(FROM);
});

it('keeps a late rich edit and exact refused sheet child under the moved recovery incarnation', async () => {
  render(<LiveNote />);
  await waitFor(() => expect(richReady).not.toBeNull());
  const owner = retainedDocumentOwner(key(FROM))!;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const native = vi.spyOn(ipc, 'renameNote').mockImplementationOnce(async (vault, old, next) => {
    await gate;
    return mock.renameNote(vault, old, next);
  });
  let pending!: ReturnType<typeof rename>;
  await act(async () => {
    pending = rename();
  });
  await waitFor(() => expect(native).toHaveBeenCalled());
  const info = richReady!;
  const paragraph = info.editor.document.find((block) =>
    JSON.stringify(block.content).includes('Exact body'),
  )!;
  act(() => info.editor.updateBlock(paragraph, { content: 'Rich typed during move 😀' }));
  let stop!: () => void;
  act(() => {
    stop = registerSheetDraft(
      info.editor,
      'detached-sheet',
      () => false,
      () => ({ cell: { row: 0, column: 0 }, text: '=REFUSED exact 😀', origin: 'bar' }),
    );
  });
  await act(async () => {
    expect((await flushOpenPages()).unresolvedOwnerIds.length).toBeGreaterThan(0);
  });
  const before = recoveryDrafts(key(FROM))[0];
  expect(before.payload.children.sheets).toContain('=REFUSED exact 😀');
  await act(async () => {
    release();
    await pending;
  });
  await waitFor(() => expect(retainedDocumentOwner(key(TO))).toBe(owner));
  const after = recoveryDrafts(key(TO))[0];
  expect(after.ref.instanceId).toBe(before.ref.instanceId);
  expect(after.payload.body!.text).toContain('Rich typed during move 😀');
  expect(after.payload.children.sheets).toContain('=REFUSED exact 😀');
  await act(async () => {
    expect((await flushOpenPages()).unresolvedOwnerIds.length).toBeGreaterThan(0);
  });
  expect(fs().has(FROM)).toBe(false);
  expect(fs().get(TO)).toBe(RAW);
  act(() => stop());
});

it('ignores an old-path canvas read that finishes after the destination attaches', async () => {
  const { from, to } = await seedBoard('canvas');
  if (canvas.state !== 'ready') throw new Error('canvas not ready');
  const original = fs().get(from)!;
  const earlier = JSON.parse(original);
  earlier.nodes[0].x = 17;
  fs().set(from, JSON.stringify(earlier));
  const stale = await ipc.readCanvasFile(VAULT, from);
  fs().set(from, original);
  let release!: (value: typeof stale) => void;
  let releaseFresh!: (value: typeof stale) => void;
  const read = vi
    .spyOn(ipc, 'readCanvasFile')
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFresh = resolve;
        }),
    );
  let loading!: Promise<void>;
  await act(async () => {
    loading = canvas.state === 'ready' ? canvas.reload() : Promise.resolve();
  });
  await waitFor(() => expect(release).toBeTypeOf('function'));
  await act(async () => {
    expect(
      await renameKeepingLinks({ steps: [{ from, to }], label: 'Moved while reading' }),
    ).not.toBeNull();
  });
  await act(async () => {
    release(stale);
  });
  await waitFor(() => expect(releaseFresh).toBeTypeOf('function'));
  try {
    expect(canvas).toMatchObject({ state: 'ready' });
    if (canvas.state === 'ready') expect(canvas.editor.board.nodes.get('a')!.x).toBe(0);
  } finally {
    await act(async () => {
      releaseFresh({ ok: true, ...(await mock.readCanvasFile(VAULT, to)) });
      await loading;
    });
  }
  expect(fs().get(to)).toBe(original);
  expect(read.mock.calls.at(-1)?.[1]).toBe(to);
});

it('moves a released source preference without retaining stale document bytes', async () => {
  await source();
  cleanup();
  expect(retainedDocumentOwner(key(FROM))).toBeUndefined();
  expect(documentPresentationOf(key(FROM))).toBe('source');
  await act(async () => {
    expect(await rename()).not.toBeNull();
  });
  expect(documentPresentationOf(key(TO))).toBe('source');
  expect(documentPresentationOf(key(FROM))).toBe('rich');
  fs().set(TO, RAW.replace('Exact body 😀', 'New authoritative source 😀'));
  render(<LiveNote />);
  expect(await screen.findByRole('textbox', { name: 'Page source' })).toHaveProperty(
    'value',
    '\n# Identity\n\nNew authoritative source 😀\n',
  );
  expect(fs().has(FROM)).toBe(false);
});
it('keeps active source generations safe through a settled rename or explicit retry', async () => {
  const input = await source();
  const native = vi.spyOn(ipc, 'renameNote');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const save = vi.spyOn(ipc, 'saveNoteBody').mockImplementationOnce(async (request) => {
    await gate;
    return mock.saveNoteBody(request);
  });
  fireEvent.change(input, { target: { value: '\n# Identity\n\nFirst save generation 😀\n' } });
  let writing!: ReturnType<typeof flushOpenPages>;
  await act(async () => {
    writing = flushOpenPages();
  });
  await waitFor(() => expect(save).toHaveBeenCalled());
  fireEvent.change(input, { target: { value: '\n# Identity\n\nNewest source generation 😀\n' } });
  let pending!: ReturnType<typeof rename>;
  await act(async () => {
    pending = rename();
  });
  expect(native).not.toHaveBeenCalled();
  const originalOwner = retainedDocumentOwner(key(FROM))!;
  expect(originalOwner.snapshot().inFlightGeneration).not.toBeNull();
  let moved: Awaited<ReturnType<typeof rename>> = null;
  await act(async () => {
    release();
    await writing;
    moved = await pending;
  });
  if (moved === null) {
    expect(native).not.toHaveBeenCalled();
    expect(fs().get(FROM)).toBe(RAW.replace('Exact body 😀', 'Newest source generation 😀'));
    expect(originalOwner.snapshot().latestDraft).toBe(
      '\r\n# Identity\r\n\r\nNewest source generation 😀\r\n',
    );
    expect(useUiStore.getState().toasts.at(-1)?.message).toContain('Retry save');
    await waitFor(() => expect(originalOwner.snapshot().reconcileRequired).not.toBe(true));
    await act(async () => {
      expect(await rename()).not.toBeNull();
    });
  }
  expect(native).toHaveBeenCalledTimes(1);
  expect(retainedDocumentOwner(key(TO))).toBe(originalOwner);
  expect(fs().get(TO)).toBe(RAW.replace('Exact body 😀', 'Newest source generation 😀'));
  expect(fs().has(FROM)).toBe(false);
  expect(originalOwner.snapshot().generation).toBe(originalOwner.snapshot().acknowledgedGeneration);
});

it('holds a document first attached while the existing rename IPC is pending', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const native = vi.spyOn(ipc, 'renameNote').mockImplementationOnce(async (vault, old, next) => {
    await gate;
    return mock.renameNote(vault, old, next);
  });
  let pending!: ReturnType<typeof rename>;
  await act(async () => {
    pending = rename();
  });
  await waitFor(() => expect(native).toHaveBeenCalled());
  render(<LiveNote />);
  await waitFor(() => expect(richReady).not.toBeNull());
  const info = richReady!;
  const paragraph = info.editor.document.find((block) =>
    JSON.stringify(block.content).includes('Exact body'),
  )!;
  act(() => info.editor.updateBlock(paragraph, { content: 'First attached during move 😀' }));
  try {
    await act(async () => {
      expect((await flushOpenPages()).unresolvedOwnerIds.length).toBeGreaterThan(0);
    });
    expect(fs().get(FROM)).toBe(RAW);
  } finally {
    await act(async () => {
      release();
      await pending;
    });
  }
  await act(() => flushOpenPages());
  expect(fs().get(TO)).toContain('First attached during move 😀');
  expect(fs().has(FROM)).toBe(false);
});

it('retains a clean canvas scene while its presentation is absent during rename', async () => {
  const { from, to } = await seedBoard('canvas');
  if (canvas.state !== 'ready') throw new Error('canvas not ready');
  const scene = canvas.editor;
  act(() => {
    scene.begin('Move');
    scene.preview(new Map([['n:a', { ...scene.board.nodes.get('a')!, x: 42 }]]));
    scene.commit();
  });
  await act(() => flushOpenPages());
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const native = vi.spyOn(ipc, 'renameNote').mockImplementationOnce(async (vault, old, next) => {
    await gate;
    return mock.renameNote(vault, old, next);
  });
  let pending!: ReturnType<typeof renameKeepingLinks>;
  await act(async () => {
    pending = renameKeepingLinks({ steps: [{ from, to }], label: 'Moved absent canvas' });
  });
  await waitFor(() => expect(native).toHaveBeenCalled());
  await act(async () => {
    cleanup();
  });
  await act(async () => {
    release();
    await pending;
  });
  render(<LiveBoard kind="canvas" />);
  await waitFor(() => expect(canvas.state).toBe('ready'));
  if (canvas.state !== 'ready') throw new Error('canvas not ready');
  expect(canvas.editor).toBe(scene);
  act(() => {
    scene.begin('Another move');
    scene.preview(new Map([['n:a', { ...scene.board.nodes.get('a')!, x: 77 }]]));
    scene.commit();
  });
  await act(() => flushOpenPages());
  expect(JSON.parse(fs().get(to)!).nodes[0].x).toBe(77);
  act(() => scene.undo());
  await act(() => flushOpenPages());
  expect(JSON.parse(fs().get(to)!).nodes[0].x).toBe(42);
  expect(fs().has(from)).toBe(false);
});

it('refuses a conflicting move intent before a second native rename can start', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const native = vi.spyOn(ipc, 'renameNote').mockImplementationOnce(async (vault, old, next) => {
    await gate;
    return mock.renameNote(vault, old, next);
  });
  let first!: ReturnType<typeof rename>;
  await act(async () => {
    first = rename();
  });
  await waitFor(() => expect(native).toHaveBeenCalledTimes(1));
  try {
    expect(
      await renameKeepingLinks({
        steps: [{ from: FROM, to: 'inbox/identity-competing.md' }],
        label: 'Competing move',
      }),
    ).toBeNull();
    expect(native).toHaveBeenCalledTimes(1);
    expect(fs().get(FROM)).toBe(RAW);
    expect(fs().has('inbox/identity-competing.md')).toBe(false);
  } finally {
    await act(async () => {
      release();
      await first;
    });
  }
  expect(fs().get(TO)).toBe(RAW);
  expect(fs().has(FROM)).toBe(false);
});

it('repair1 holds a canvas remounted at the source while native rename waits', async () => {
  const { from, to } = await seedBoard('canvas');
  if (canvas.state !== 'ready') throw new Error('canvas not ready');
  const scene = canvas.editor;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const native = vi.spyOn(ipc, 'renameNote').mockImplementationOnce(async (vault, old, next) => {
    await gate;
    return mock.renameNote(vault, old, next);
  });
  let pending!: ReturnType<typeof renameKeepingLinks>;
  await act(async () => {
    pending = renameKeepingLinks({ steps: [{ from, to }], label: 'Review pending remount' });
  });
  await waitFor(() => expect(native).toHaveBeenCalled());
  try {
    await act(async () => {
      cleanup();
    });
    render(<LiveBoard kind="canvas" />);
    await waitFor(() => expect(canvas.state).toBe('ready'));
    if (canvas.state !== 'ready') throw new Error('canvas not ready');
    expect(canvas.editor).toBe(scene);
    act(() => {
      scene.begin('Late source remount move');
      scene.preview(new Map([['n:a', { ...scene.board.nodes.get('a')!, x: 73 }]]));
      scene.commit();
    });
    let report!: Awaited<ReturnType<typeof flushOpenPages>>;
    await act(async () => {
      report = await flushOpenPages();
    });
    expect(JSON.parse(fs().get(from)!).nodes[0].x).toBe(0);
    expect(report.unresolvedOwnerIds.length).toBeGreaterThan(0);
  } finally {
    await act(async () => {
      release();
      await pending;
    });
  }
});

it('repair1 ignores a rejected old-path canvas read after destination attachment', async () => {
  const { from, to } = await seedBoard('canvas');
  let rejectOld!: (reason: Error) => void;
  let releaseFresh!: (value: Awaited<ReturnType<typeof ipc.readCanvasFile>>) => void;
  const read = vi
    .spyOn(ipc, 'readCanvasFile')
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectOld = reject;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFresh = resolve;
        }),
    );
  let loading!: Promise<void>;
  await act(async () => {
    loading = canvas.state === 'ready' ? canvas.reload() : Promise.resolve();
  });
  await waitFor(() => expect(rejectOld).toBeTypeOf('function'));
  await act(async () => {
    expect(
      await renameKeepingLinks({ steps: [{ from, to }], label: 'Review rejected read' }),
    ).not.toBeNull();
  });
  try {
    await act(async () => {
      rejectOld(new Error('old path disappeared'));
    });
    await waitFor(() => expect(releaseFresh).toBeTypeOf('function'));
    expect(canvas.state).toBe('ready');
    if (canvas.state === 'ready') expect(canvas.held).toBeNull();
  } finally {
    await act(async () => {
      releaseFresh({ ok: true, ...(await mock.readCanvasFile(VAULT, to)) });
      await loading;
    });
  }
  expect(read.mock.calls.at(-1)?.[1]).toBe(to);
});

it('repair1 preserves a retained deleted destination identity and recovery payload', async () => {
  const deleted = retainDocumentOwner(key(TO), 'Original deleted destination', async () => {
    throw new Error('deleted target must not write');
  });
  deleted.edit('Exact deleted destination retained draft 😀');
  deleted.holdRecovery();
  const recovery = recoveryDrafts(key(TO))[0];
  expect(recovery.payload.body!.text).toBe('Exact deleted destination retained draft 😀');
  expect(fs().has(TO)).toBe(false);
  await source();
  let result!: Awaited<ReturnType<typeof rename>>;
  await act(async () => {
    result = await rename();
  });
  const after = recoveryDrafts(key(TO));
  expect({
    retainedIdentity: retainedDocumentOwner(key(TO)) === deleted,
    retainedRecovery: after.some(
      (draft) =>
        draft.ref.instanceId === recovery.ref.instanceId &&
        draft.payload.body?.text === 'Exact deleted destination retained draft 😀',
    ),
    moveRefused: result === null,
    sourceBytes: fs().get(FROM),
  }).toEqual({
    retainedIdentity: true,
    retainedRecovery: true,
    moveRefused: true,
    sourceBytes: RAW,
  });
});

it('repair1 settles a clean canvas absent after acknowledged rename before remount', async () => {
  const { from, to } = await seedBoard('canvas');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const native = vi.spyOn(ipc, 'renameNote').mockImplementationOnce(async (vault, old, next) => {
    await gate;
    return mock.renameNote(vault, old, next);
  });
  let pending!: ReturnType<typeof renameKeepingLinks>;
  await act(async () => {
    pending = renameKeepingLinks({ steps: [{ from, to }], label: 'Review absent settled canvas' });
  });
  await waitFor(() => expect(native).toHaveBeenCalled());
  await act(async () => {
    cleanup();
  });
  await act(async () => {
    release();
    expect(await pending).not.toBeNull();
  });
  expect(fs().has(from)).toBe(false);
  expect(JSON.parse(fs().get(to)!).nodes[0].x).toBe(0);
  let report!: Awaited<ReturnType<typeof flushOpenPages>>;
  await act(async () => {
    report = await flushOpenPages();
  });
  act(() => useNavStore.getState().navigate({ kind: 'home' }));
  await act(async () => {
    await flushOpenPages();
  });
  expect({
    unresolved: report.unresolvedOwnerIds,
    selection: useNavStore.getState().selection,
  }).toEqual({ unresolved: [], selection: { kind: 'home' } });
});

function pauseMove(refused = false) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const native = vi.spyOn(ipc, 'renameNote').mockImplementationOnce(async (vault, from, to) => {
    await gate;
    if (refused) throw new Error('native move refused');
    return mock.renameNote(vault, from, to);
  });
  return { release, native };
}

it.each([false, true])(
  'repair1 keeps remounted Canvas late geometry through native refusal=%s',
  async (refused) => {
    const { from, to } = await seedBoard('canvas');
    if (canvas.state !== 'ready') throw new Error('not ready');
    const scene = canvas.editor;
    const saves = vi.spyOn(ipc, 'saveCanvasFile');
    const gate = pauseMove(refused);
    let pending!: ReturnType<typeof renameKeepingLinks>;
    await act(async () => {
      pending = renameKeepingLinks({ steps: [{ from, to }], label: 'Remount' });
    });
    await waitFor(() => expect(gate.native).toHaveBeenCalled());
    try {
      await act(async () => cleanup());
      render(<LiveBoard kind="canvas" />);
      await waitFor(() => expect(canvas.state).toBe('ready'));
      act(() => {
        scene.begin('Late remounted geometry');
        scene.preview(new Map([['n:a', { ...scene.board.nodes.get('a')!, x: 73 }]]));
        scene.commit();
      });
      await act(async () => {
        expect((await flushOpenPages()).unresolvedOwnerIds.length).toBeGreaterThan(0);
      });
      expect(saves).not.toHaveBeenCalled();
      expect(JSON.parse(fs().get(from)!).nodes[0].x).toBe(0);
    } finally {
      await act(async () => {
        gate.release();
        await pending;
      });
    }
    await waitFor(() => expect(canvas.state).toBe('ready'));
    await act(() => flushOpenPages());
    expect(JSON.parse(fs().get(refused ? from : to)!).nodes[0].x).toBe(73);
    expect(fs().has(refused ? to : from)).toBe(false);
    if (canvas.state === 'ready') expect(canvas.editor).toBe(scene);
  },
);

it.each(['open', 'cancelled'] as const)(
  'repair1 defers a late destination note reader until settlement: %s',
  async (outcome) => {
    await source();
    const original = retainedDocumentOwner(key(FROM));
    const gate = pauseMove();
    let pending!: ReturnType<typeof rename>;
    await act(async () => {
      pending = rename();
    });
    await waitFor(() => expect(gate.native).toHaveBeenCalled());
    await act(async () => cleanup());
    const reads = vi.spyOn(ipc, 'readNote');
    const view = render(
      <PaneContext.Provider value="p93">
        <NoteBodyEditor path={TO} debounceMs={60_000} />
      </PaneContext.Provider>,
    );
    try {
      await act(async () => {});
      expect(reads.mock.calls.filter(([, path]) => path === TO)).toHaveLength(0);
      expect(view.queryByTestId('markdown-editor')).toBeNull();
      if (outcome === 'cancelled') view.unmount();
    } finally {
      await act(async () => {
        gate.release();
        await pending;
      });
    }
    if (outcome === 'open') {
      await screen.findByRole('textbox', { name: 'Page source' });
      expect(retainedDocumentOwner(key(TO))).toBe(original);
    } else {
      await act(async () => {});
      expect(reads.mock.calls.filter(([, path]) => path === TO)).toHaveLength(0);
    }
  },
);

it('repair1 defers a late destination field before editable creation and reuses the moved owner', async () => {
  render(<LiveField />);
  await waitFor(() => expect(field).not.toBeNull());
  const original = field!.owner;
  const gate = pauseMove();
  let pending!: ReturnType<typeof rename>;
  await act(async () => {
    pending = rename();
  });
  await waitFor(() => expect(gate.native).toHaveBeenCalled());
  await act(async () => cleanup());
  render(
    <FocusedFieldInput
      identity={{ ...key(TO), ownerId: 'field:status' }}
      initial="stale value"
      label="Late status"
      onEnd={() => {}}
      validate={(value) => ({ ok: true, value })}
      write={async (value) => {
        await ipc.updateFrontmatter(VAULT, TO, { status: value });
        return true;
      }}
    />,
  );
  try {
    expect(screen.queryByRole('textbox', { name: 'Late status' })).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('moving');
    expect(retainedSaveParticipant({ ...key(TO), ownerId: 'field:status' })).toBeUndefined();
  } finally {
    await act(async () => {
      gate.release();
      await pending;
    });
  }
  const input = await screen.findByRole('textbox', { name: 'Late status' });
  expect(input).toHaveProperty('value', 'draft');
  expect(retainedSaveParticipant({ ...key(TO), ownerId: 'field:status' })).toBe(original);
  fireEvent.change(input, { target: { value: 'late destination status' } });
  await act(() => flushOpenPages());
  expect(fs().get(TO)).toContain('late destination status');
  expect(fs().has(FROM)).toBe(false);
});

it('repair1 exposes both authored same-path incarnations through recovery cards and isolates actions', async () => {
  const input = await source();
  const original = retainedDocumentOwner(key(FROM))!;
  const gate = pauseMove();
  let pending!: ReturnType<typeof rename>;
  await act(async () => {
    pending = rename();
  });
  await waitFor(() => expect(gate.native).toHaveBeenCalled());
  let late!: ReturnType<typeof retainDocumentOwner>;
  try {
    act(() => {
      fireEvent.change(input, { target: { value: '# Source authored during move 😀\r\n' } });
      late = retainDocumentOwner(key(TO), 'Old destination', async () => {
        throw new Error('pending destination cannot write');
      });
      late.edit('Exact separate destination draft 😀\r\n', 'source');
    });
    expect(late).not.toBe(original);
  } finally {
    await act(async () => {
      gate.release();
      await pending;
    });
  }
  act(() => original.holdRecovery());
  await act(async () => cleanup());
  const drafts = recoveryDrafts(key(TO));
  expect(drafts).toHaveLength(2);
  const sourceRef = drafts.find((draft) => !draft.deferredAdmission)!.ref;
  const lateRef = drafts.find((draft) => draft.deferredAdmission)!.ref;
  expect(sourceRef.instanceId).not.toBe(lateRef.instanceId);
  expect(retainedDocumentOwner(key(TO))).toBe(original);
  const sourceText = original.snapshot().latestDraft;
  const clipboard = vi.spyOn(ipc, 'writeClipboard').mockResolvedValue();
  render(<DeletedDraftRecovery vaultId={VAULT} path={TO} fallback={null} />);
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'Copy body' })).toHaveLength(2));
  const cards = screen.getAllByRole('region', { name: /Page draft/ });
  const lateCard = cards.find((card) =>
    card.textContent?.includes('Another draft owns this path'),
  )!;
  const sourceCard = cards.find((card) => card !== lateCard)!;
  expect(
    within(lateCard).getByRole('button', { name: /Reload restored page|Check again/ }),
  ).toHaveProperty('disabled', true);
  fireEvent.click(within(lateCard).getByRole('button', { name: 'Copy body' }));
  await waitFor(() =>
    expect(clipboard).toHaveBeenCalledWith('Exact separate destination draft 😀\r\n'),
  );
  fireEvent.click(within(sourceCard).getByRole('button', { name: 'Copy body' }));
  await waitFor(() => expect(clipboard).toHaveBeenCalledWith(sourceText));
  expect((await flushOpenPages()).unresolvedOwnerIds.length).toBeGreaterThan(0);
  vi.spyOn(ipc, 'chooseDraftExport').mockResolvedValue({
    kind: 'chosen',
    token: 'pending-incarnation',
  });
  const exported = vi
    .spyOn(ipc, 'commitDraftExport')
    .mockResolvedValue({ kind: 'exported', destination: '/tmp/retained-draft.json' });
  fireEvent.click(within(lateCard).getByRole('button', { name: 'Save as…' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save recovery file' }));
  await waitFor(() => expect(exported).toHaveBeenCalledOnce());
  expect(JSON.parse(exported.mock.calls[0][2]).body.text).toBe(
    'Exact separate destination draft 😀\r\n',
  );
  expect(original.snapshot().latestDraft).toBe(sourceText);
  expect(recoveryDrafts(key(TO)).map((draft) => draft.ref.instanceId)).toEqual(
    drafts.map((draft) => draft.ref.instanceId),
  );
  fireEvent.click(
    within(screen.getByRole('dialog', { name: 'Save retained draft as' })).getByRole('button', {
      name: 'Cancel',
    }),
  );
  fireEvent.click(within(lateCard).getByRole('button', { name: 'Discard this draft' }));
  fireEvent.click(screen.getByRole('button', { name: 'Discard permanently' }));
  await waitFor(() => expect(recoveryDrafts(key(TO))).toHaveLength(1));
  expect(recoveryDrafts(key(TO))[0].ref.instanceId).toBe(sourceRef.instanceId);
  expect(original.snapshot().latestDraft).toBe(sourceText);
  expect(retainedDocumentOwner(key(TO))).toBe(original);
});

it('repair1 releases the clean absent Canvas lifetime on vault teardown', async () => {
  const { from, to } = await seedBoard('canvas');
  if (canvas.state !== 'ready') throw new Error('not ready');
  const dispose = vi.spyOn(canvas.editor, 'dispose');
  const gate = pauseMove();
  let pending!: ReturnType<typeof renameKeepingLinks>;
  await act(async () => {
    pending = renameKeepingLinks({ steps: [{ from, to }], label: 'Absent clean' });
  });
  await waitFor(() => expect(gate.native).toHaveBeenCalled());
  await act(async () => cleanup());
  await act(async () => {
    gate.release();
    await pending;
  });
  await act(() => flushOpenPages());
  expect(retainedSaveParticipant(key(to))).toBeDefined();
  expect(dispose).not.toHaveBeenCalled();
  act(() => useVaultStore.setState({ vaultPath: '/another-vault' }));
  expect(dispose).toHaveBeenCalledOnce();
  expect(retainedSaveParticipant(key(to))).toBeUndefined();
});

it.each([
  [
    { from: 'notes/reservation-from', to: 'notes/reservation-to' },
    'notes/reservation-to/deleted-child.md',
  ],
  [{ from: FROM, to: TO }, 'ignored'],
] as const)(
  'repair1 reserves retained destination scopes for folder and chained moves %#',
  async (step, placeholder) => {
    if (placeholder !== 'ignored') {
      fs().set(`${step.from}/unique-reservation-source.md`, RAW);
      await useVaultStore.getState().rescan();
    }
    const steps =
      placeholder === 'ignored'
        ? [
            { from: FROM, to: TO },
            { from: TO, to: 'archive/final.md' },
          ]
        : [step];
    const destination = placeholder === 'ignored' ? 'archive/final.md' : placeholder;
    const retained = retainDocumentOwner({ ...key(destination) }, 'base', async () => {
      throw new Error('must not write');
    });
    retained.edit('Exact retained child');
    retained.holdRecovery();
    const ref = recoveryDrafts(key(destination))[0].ref;
    const native = vi.spyOn(ipc, 'renameNote');
    const batch = vi.spyOn(ipc, 'applyBatch');
    await act(async () => {
      expect(await renameKeepingLinks({ steps, label: 'Reserved destination' })).toBeNull();
    });
    expect(native).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
    expect(retainedDocumentOwner(key(destination))).toBe(retained);
    expect(recoveryDrafts(key(destination))[0].ref.instanceId).toBe(ref.instanceId);
    expect(fs().get(FROM)).toBe(RAW);
  },
);

it.each(['canvas', 'diagram'] as const)(
  'repair1 defers a late %s destination reader and reuses its exact owner',
  async (kind) => {
    const { from, to } = await seedBoard(kind);
    const original =
      kind === 'canvas' ? retainedSaveParticipant(key(from)) : retainedDocumentOwner(key(from));
    const gate = pauseMove();
    let pending!: ReturnType<typeof renameKeepingLinks>;
    await act(async () => {
      pending = renameKeepingLinks({ steps: [{ from, to }], label: 'Late board reader' });
    });
    await waitFor(() => expect(gate.native).toHaveBeenCalled());
    await act(async () => cleanup());
    const canvasReads = vi.spyOn(ipc, 'readCanvasFile');
    const diagramReads = vi.spyOn(ipc, 'readNote');
    render(
      <PaneContext.Provider value="p93">
        {kind === 'canvas' ? <BoardHook path={to} /> : <DiagramHook path={to} />}
      </PaneContext.Provider>,
    );
    try {
      await act(async () => {});
      expect(canvasReads.mock.calls.filter(([, path]) => path === to)).toHaveLength(0);
      expect(diagramReads.mock.calls.filter(([, path]) => path === to)).toHaveLength(0);
      expect(
        kind === 'canvas' ? retainedSaveParticipant(key(to)) : retainedDocumentOwner(key(to)),
      ).toBeUndefined();
    } finally {
      await act(async () => {
        gate.release();
        await pending;
      });
    }
    await waitFor(() =>
      expect(kind === 'canvas' ? canvas.state === 'ready' : diagram?.code !== null).toBe(true),
    );
    expect(
      kind === 'canvas' ? retainedSaveParticipant(key(to)) : retainedDocumentOwner(key(to)),
    ).toBe(original);
  },
);

it('repair1 flushes late dirty Canvas geometry at its moved path while absent and keeps editor Undo', async () => {
  const { from, to } = await seedBoard('canvas');
  if (canvas.state !== 'ready') throw new Error('not ready');
  const scene = canvas.editor;
  const gate = pauseMove();
  let pending!: ReturnType<typeof renameKeepingLinks>;
  await act(async () => {
    pending = renameKeepingLinks({ steps: [{ from, to }], label: 'Absent dirty' });
  });
  await waitFor(() => expect(gate.native).toHaveBeenCalled());
  await act(async () => cleanup());
  act(() => {
    scene.begin('Late absent geometry');
    scene.preview(new Map([['n:a', { ...scene.board.nodes.get('a')!, x: 91 }]]));
    scene.commit();
  });
  try {
    await act(async () => {
      expect((await flushOpenPages()).unresolvedOwnerIds.length).toBeGreaterThan(0);
    });
    expect(JSON.parse(fs().get(from)!).nodes[0].x).toBe(0);
  } finally {
    await act(async () => {
      gate.release();
      await pending;
    });
  }
  await act(async () => {
    expect((await flushOpenPages()).unresolvedOwnerIds).toEqual([]);
  });
  expect(JSON.parse(fs().get(to)!).nodes[0].x).toBe(91);
  act(() => useNavStore.getState().navigate({ kind: 'home' }));
  expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
  render(
    <PaneContext.Provider value="p93">
      <BoardHook path={to} />
    </PaneContext.Provider>,
  );
  await waitFor(() => expect(canvas.state).toBe('ready'));
  if (canvas.state === 'ready') expect(canvas.editor).toBe(scene);
  act(() => scene.undo());
  await act(() => flushOpenPages());
  expect(JSON.parse(fs().get(to)!).nodes[0].x).toBe(0);
  expect(fs().has(from)).toBe(false);
});

it('repair1 refuses a deleted destination kept only by a field participant', async () => {
  const fieldOwner = new FieldSaveParticipant(
    { ...key(TO), ownerId: 'field:status' },
    'before',
    (value) => ({ ok: true, value }),
    async () => {
      throw new Error('must not write');
    },
  );
  fieldOwner.edit('Exact retained destination field 😀');
  fieldOwner.recovery.hold();
  registerSaveParticipant(fieldOwner);
  const ref = recoveryDrafts(key(TO))[0].ref;
  await source();
  const native = vi.spyOn(ipc, 'renameNote');
  await act(async () => {
    expect(await rename()).toBeNull();
  });
  expect(native).not.toHaveBeenCalled();
  expect(retainedSaveParticipant(fieldOwner.key)).toBe(fieldOwner);
  expect(recoveryDrafts(key(TO))[0].ref.instanceId).toBe(ref.instanceId);
  expect(fieldOwner.snapshot().latestDraft).toBe('Exact retained destination field 😀');
  expect(fs().get(FROM)).toBe(RAW);
});

it('repair1 refuses a destination kept solely by a recovery registration', async () => {
  const recovering = new DocumentOwner(key(TO), 'before', async () => {
    throw new Error('must not write');
  });
  recovering.edit('Exact recovery-only destination 😀', 'source');
  recovering.holdRecovery();
  registerRecovery({
    key: recovering.key,
    identity: recovering,
    snapshot: () => recovering.snapshot(),
    subscribe: (notify) => recovering.subscribe(notify),
    busy: () => false,
    hold: () => recovering.holdRecovery(),
    requiresRecovery: () => true,
    retire: () => recovering.retireRecovery(),
    payload: () => ({
      kind: 'markdown',
      body: { format: 'source', text: recovering.snapshot().latestDraft },
      field: null,
      children: {},
      metadata: { kind: 'unavailable' },
    }),
  });
  const ref = recoveryDrafts(key(TO))[0].ref;
  await source();
  const native = vi.spyOn(ipc, 'renameNote');
  await act(async () => {
    expect(await rename()).toBeNull();
  });
  expect(native).not.toHaveBeenCalled();
  const kept = recoveryDrafts(key(TO))[0];
  expect(kept.ref.instanceId).toBe(ref.instanceId);
  expect(kept.payload.body!.text).toBe('Exact recovery-only destination 😀');
  expect(fs().get(FROM)).toBe(RAW);
});

it('repair1 keeps the exact field owner when an old attachment rerenders after acknowledgement', async () => {
  const identity = { ...key(FROM), ownerId: 'field:status' };
  const props = {
    initial: 'draft',
    label: 'Parked status',
    onEnd: () => {},
    validate: (value: string) => ({ ok: true as const, value }),
  };
  render(
    <FocusedFieldInput
      {...props}
      identity={identity}
      write={async (value) => {
        await ipc.updateFrontmatter(VAULT, FROM, { status: value });
        return true;
      }}
    />,
  );
  const original = retainedSaveParticipant(identity)!;
  await act(async () => {
    expect(await rename()).not.toBeNull();
  });
  const writes = vi.spyOn(ipc, 'updateFrontmatter');
  fireEvent.change(screen.getByRole('textbox', { name: 'Parked status' }), {
    target: { value: 'After ack before replacement 😀' },
  });
  expect(original.snapshot().latestDraft).toBe('After ack before replacement 😀');
  expect(retainedSaveParticipant({ ...identity, path: TO })).toBe(original);
  await act(async () => {
    expect((await flushOpenPages()).unresolvedOwnerIds.length).toBeGreaterThan(0);
  });
  expect(writes).not.toHaveBeenCalled();
  expect(fs().has(FROM)).toBe(false);
  const otherPath = 'inbox/unrelated-field.md';
  fs().set(otherPath, '# Other field\n');
  render(
    <FocusedFieldInput
      {...props}
      label="Unrelated status"
      identity={{ ...identity, path: otherPath }}
      write={async (value) => {
        await ipc.updateFrontmatter(VAULT, otherPath, { status: value });
        return true;
      }}
    />,
  );
  fireEvent.change(screen.getByRole('textbox', { name: 'Unrelated status' }), {
    target: { value: 'Unrelated still usable' },
  });
  await act(() => flushOpenPages());
  expect(fs().get(otherPath)).toContain('Unrelated still usable');
  expect(writes.mock.calls.filter(([, path]) => path === FROM)).toHaveLength(0);
  expect(original.snapshot().latestDraft).toBe('After ack before replacement 😀');
  await act(async () => cleanup());
  render(
    <FocusedFieldInput
      {...props}
      identity={{ ...identity, path: TO }}
      write={async (value) => {
        await ipc.updateFrontmatter(VAULT, TO, { status: value });
        return true;
      }}
    />,
  );
  await act(() => flushOpenPages());
  expect(fs().get(TO)).toContain('After ack before replacement 😀');
  expect(fs().has(FROM)).toBe(false);
});

it('repair2 retires a discarded deferred body wrapper from the global save barrier', async () => {
  const gate = pauseMove();
  let pending!: ReturnType<typeof rename>;
  await act(async () => {
    pending = rename();
  });
  await waitFor(() => expect(gate.native).toHaveBeenCalled());
  let late!: DocumentOwner;
  let detach!: () => void;
  try {
    act(() => {
      late = retainDocumentOwner(key(TO), 'Speculative destination', async () => {
        throw new Error('deferred owner cannot write');
      });
      late.edit('Authored late wrapper retained exactly 😀', 'source');
      detach = registerSaveParticipant({
        identity: late,
        key: late.key,
        snapshot: () => late.snapshot(),
        prepare: () => {},
        flush: () => late.flush(),
      });
    });
  } finally {
    await act(async () => {
      gate.release();
      await pending;
    });
  }
  act(() => detach());
  render(<DeletedDraftRecovery vaultId={VAULT} path={TO} fallback={null} />);
  await screen.findByRole('button', { name: 'Discard this draft' });
  expect(recoveryDrafts(key(TO))).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Discard this draft' }));
  fireEvent.click(screen.getByRole('button', { name: 'Discard permanently' }));
  await waitFor(() => expect(recoveryDrafts(key(TO))).toHaveLength(0));
  expect(late.recoveryRetired()).toBe(true);
  let report!: Awaited<ReturnType<typeof flushOpenPages>>;
  await act(async () => {
    report = await flushOpenPages();
  });
  act(() => useNavStore.getState().navigate({ kind: 'home' }));
  await act(async () => {
    await flushOpenPages();
  });
  expect({
    unresolved: report.unresolvedOwnerIds,
    selection: useNavStore.getState().selection,
  }).toEqual({ unresolved: [], selection: { kind: 'home' } });
});

const lateBodyWrapper = (owner: DocumentOwner) => ({
  identity: owner,
  key: owner.key,
  snapshot: () => owner.snapshot(),
  prepare: () => {},
  flush: () => owner.flush(),
});
async function deferredBodyForDisposition() {
  const gate = pauseMove();
  let pending!: ReturnType<typeof rename>;
  await act(async () => {
    pending = rename();
  });
  await waitFor(() => expect(gate.native).toHaveBeenCalled());
  let late!: DocumentOwner;
  let first!: () => void;
  let second!: () => void;
  try {
    act(() => {
      late = retainDocumentOwner(key(TO), 'Speculative old destination', async () => {
        throw new Error('deferred owner cannot write');
      });
      late.edit('Exact deferred wrapper draft 😀\r\n', 'source');
      first = registerSaveParticipant(lateBodyWrapper(late));
      second = registerSaveParticipant(lateBodyWrapper(late));
    });
  } finally {
    await act(async () => {
      gate.release();
      await pending;
    });
  }
  return { late, first, second };
}

it.each(['before', 'after', 'mounted'] as const)(
  'repair2 discards all captured body wrappers with detach %s and cannot resurrect them',
  async (ordering) => {
    const { late, first, second } = await deferredBodyForDisposition();
    if (ordering === 'before')
      act(() => {
        first();
        second();
      });
    render(<DeletedDraftRecovery vaultId={VAULT} path={TO} fallback={null} />);
    await screen.findByRole('button', { name: 'Discard this draft' });
    expect(recoveryDrafts(key(TO))[0].payload.body!.text).toBe(
      'Exact deferred wrapper draft 😀\r\n',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Discard this draft' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard permanently' }));
    await waitFor(() => expect(recoveryDrafts(key(TO))).toHaveLength(0));
    expect(late.recoveryRetired()).toBe(true);
    if (ordering === 'after')
      act(() => {
        first();
        second();
      });
    act(() => {
      // Delayed body onReady/unmount callbacks still carry the retired object.
      registerSaveParticipant(lateBodyWrapper(late));
      late.edit('Retired callback must not restore this text', 'source');
    });
    await act(async () => {
      expect((await flushOpenPages()).unresolvedOwnerIds).toEqual([]);
    });
    act(() => useNavStore.getState().navigate({ kind: 'home' }));
    expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
    expect(recoveryDrafts(key(TO))).toHaveLength(0);
    expect(late.snapshot().latestDraft).toBe('');
  },
);

it('repair2 Copy and Save-as retain the original wrappers until explicit discard and preserve a newer same-key owner', async () => {
  const { late, first, second } = await deferredBodyForDisposition();
  let newer!: DocumentOwner;
  act(() => {
    newer = retainDocumentOwner(key(TO), 'Moved persisted body', async () => {
      throw new Error('newer unresolved owner cannot write');
    });
    newer.edit('Exact newer canonical draft 😀', 'source');
    newer.holdRecovery();
    registerSaveParticipant(lateBodyWrapper(newer));
  });
  const before = recoveryDrafts(key(TO));
  const newerRef = before.find((draft) => !draft.deferredAdmission)!.ref;
  const clipboard = vi.spyOn(ipc, 'writeClipboard').mockResolvedValue();
  vi.spyOn(ipc, 'chooseDraftExport').mockResolvedValue({ kind: 'chosen', token: 'repair2-copy' });
  const exported = vi
    .spyOn(ipc, 'commitDraftExport')
    .mockResolvedValue({ kind: 'exported', destination: '/tmp/repair2-draft.json' });
  render(<DeletedDraftRecovery vaultId={VAULT} path={TO} fallback={null} />);
  await waitFor(() =>
    expect(screen.getAllByRole('button', { name: 'Discard this draft' })).toHaveLength(2),
  );
  const pendingCard = screen
    .getAllByRole('region', { name: /Page draft/ })
    .find((card) => card.textContent?.includes('Another draft owns this path'))!;
  fireEvent.click(within(pendingCard).getByRole('button', { name: 'Copy body' }));
  await waitFor(() =>
    expect(clipboard).toHaveBeenCalledWith('Exact deferred wrapper draft 😀\r\n'),
  );
  fireEvent.click(within(pendingCard).getByRole('button', { name: 'Save as…' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save recovery file' }));
  await waitFor(() => expect(exported).toHaveBeenCalledOnce());
  expect(JSON.parse(exported.mock.calls[0][2]).body.text).toBe(
    'Exact deferred wrapper draft 😀\r\n',
  );
  fireEvent.click(
    within(screen.getByRole('dialog', { name: 'Save retained draft as' })).getByRole('button', {
      name: 'Cancel',
    }),
  );
  expect(late.recoveryRetired()).toBe(false);
  expect(late.snapshot().generation).toBeGreaterThan(late.snapshot().acknowledgedGeneration);
  await act(async () => {
    expect(
      (await flushOpenPages()).unresolvedOwnerIds.some((id) => JSON.parse(id)[3] === 'pending'),
    ).toBe(true);
  });
  act(() => useNavStore.getState().navigate({ kind: 'home' }));
  await act(async () => {
    await flushOpenPages();
  });
  expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: TO });
  fireEvent.click(within(pendingCard).getByRole('button', { name: 'Discard this draft' }));
  fireEvent.click(screen.getByRole('button', { name: 'Discard permanently' }));
  await waitFor(() => expect(recoveryDrafts(key(TO))).toHaveLength(1));
  act(() => {
    first();
    second();
    registerSaveParticipant(lateBodyWrapper(late));
  });
  let report!: Awaited<ReturnType<typeof flushOpenPages>>;
  await act(async () => {
    report = await flushOpenPages();
  });
  expect(report.unresolvedOwnerIds).toEqual([JSON.stringify([VAULT, TO, 'p93'])]);
  expect(retainedDocumentOwner(key(TO))).toBe(newer);
  expect(newer.snapshot().latestDraft).toBe('Exact newer canonical draft 😀');
  expect(recoveryDrafts(key(TO))[0].ref.instanceId).toBe(newerRef.instanceId);
  act(() => useNavStore.getState().navigate({ kind: 'home' }));
  await act(async () => {
    await flushOpenPages();
  });
  expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: TO });
  fireEvent.click(screen.getByRole('button', { name: 'Discard this draft' }));
  fireEvent.click(screen.getByRole('button', { name: 'Discard permanently' }));
  await waitFor(() => expect(recoveryDrafts(key(TO))).toHaveLength(0));
  await act(async () => {
    expect((await flushOpenPages()).unresolvedOwnerIds).toEqual([]);
  });
  act(() => useNavStore.getState().navigate({ kind: 'home' }));
  expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
});

it('repair2 a busy refused discard keeps authored wrappers until the same real card can retire them', async () => {
  const { late } = await deferredBodyForDisposition();
  render(<DeletedDraftRecovery vaultId={VAULT} path={TO} fallback={null} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Discard this draft' }));
  let finish!: () => void;
  act(() => {
    finish = late.beginPreparation();
  });
  expect(screen.getByRole('button', { name: 'Discard permanently' })).toHaveProperty(
    'disabled',
    true,
  );
  expect(discardRecovery(recoveryDrafts(key(TO))[0].ref)).toEqual({
    kind: 'blocked',
    reason: 'in_flight',
  });
  expect(late.recoveryRetired()).toBe(false);
  expect(late.snapshot().latestDraft).toBe('Exact deferred wrapper draft 😀\r\n');
  await act(async () => {
    expect((await flushOpenPages()).unresolvedOwnerIds.length).toBeGreaterThan(0);
  });
  act(() => finish());
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Discard permanently' })).toHaveProperty(
      'disabled',
      false,
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Discard permanently' }));
  await waitFor(() => expect(recoveryDrafts(key(TO))).toHaveLength(0));
  await act(async () => {
    expect((await flushOpenPages()).unresolvedOwnerIds).toEqual([]);
  });
  act(() => useNavStore.getState().navigate({ kind: 'home' }));
  expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
});
