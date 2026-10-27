import { sheetRestructure, sheetFill, sheetComplete } from './ipc';
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const { invokeSpy } = vi.hoisted(() => ({ invokeSpy: vi.fn(async () => [] as unknown) }));
it('passes fill and completion coordinates unchanged through literal command keys', async () => {
  (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
  const sheets = [{ name: 'Sheet1', cells: [{ row: 1, col: 1, source: '1' }] }];
  const area = { row: 0, column: 0, width: 1, height: 1 };
  invokeSpy.mockResolvedValueOnce({ source: [['1']], target: [['1']] });
  await sheetFill(sheets, 0, area, 'rows', 1);
  expect(invokeSpy).toHaveBeenLastCalledWith('sheet_fill', {
    sheets,
    sheet: 0,
    area,
    axis: 'rows',
    to: 1,
  });
  invokeSpy.mockResolvedValueOnce({ expecting: [], replace_from: 0 });
  await sheetComplete(['Sheet1'], 0, 0, 0, '=SU', 3);
  expect(invokeSpy).toHaveBeenLastCalledWith('sheet_complete', {
    names: ['Sheet1'],
    sheet: 0,
    row: 0,
    column: 0,
    text: '=SU',
    cursor: 3,
  });
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeSpy }));
const { listenSpy } = vi.hoisted(() => ({ listenSpy: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenSpy }));
const { dragSpy } = vi.hoisted(() => ({ dragSpy: vi.fn() }));
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: dragSpy }),
}));

import {
  __resetPageWrites,
  appLink,
  calculateSheets,
  readCanvasFile,
  saveCanvasFile,
  createCanvasFile,
  takeDeepLink,
  listenDeepLinks,
  starterMarker,
  installStarterKit,
  declineStarterKit,
  applyBatch,
  askQuestion,
  cancelQuit,
  canOpenOutside,
  canPickFiles,
  deleteComment,
  deleteCommentThread,
  deleteNote,
  finishQuit,
  importAttachment,
  importAttachmentBytes,
  inspectDropped,
  extractDocument,
  readDroppedText,
  listenOsFileDrop,
  ingestItemState,
  ledgerHead,
  ledgerStatus,
  listComments,
  listTrash,
  listenCommentsChanged,
  listenQuitRequested,
  listenVaultChanged,
  logFrontend,
  openAgentLink,
  openInDefaultApp,
  pageWriteFailures,
  replyToCommentThread,
  restoreFromTrash,
  revealInFinder,
  saveNote,
  scanVault,
  setCommentThreadResolved,
  setNoteTitle,
  settlePageWrites,
  startCommentThread,
  startWatcher,
  updateFrontmatter,
  writeClipboard,
} from './ipc';

afterEach(() => {
  invokeSpy.mockClear();
  listenSpy.mockReset();
  dragSpy.mockReset();
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
});

describe('ipc backend detection', () => {
  it('extracts only the named kept document through literal command keys', async () => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    const result = {
      format: 'docx',
      sha256: 'a'.repeat(64),
      bytes: 8,
      outcome: { state: 'encrypted' },
    };
    invokeSpy.mockResolvedValueOnce(result);
    expect(await extractDocument('/my-vault', 'attachments/Plan.docx')).toEqual(result);
    expect(invokeSpy).toHaveBeenLastCalledWith('extract_document', {
      vault: '/my-vault',
      path: 'attachments/Plan.docx',
    });
  });
  it('passes dropped paths literally and maps physical event coordinates to CSS pixels', async () => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    await inspectDropped(['/outside/a.md']);
    expect(invokeSpy).toHaveBeenLastCalledWith('inspect_dropped', { paths: ['/outside/a.md'] });
    await readDroppedText('/outside/a.md');
    expect(invokeSpy).toHaveBeenLastCalledWith('read_dropped_text', { path: '/outside/a.md' });
    const oldRatio = window.devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
    const handler = vi.fn();
    const stop = vi.fn();
    dragSpy.mockResolvedValue(stop);
    expect(await listenOsFileDrop(handler)).toBe(stop);
    const receive = dragSpy.mock.calls[0][0];
    receive({ payload: { type: 'enter', paths: ['/outside/a.md'], position: { x: 20, y: 40 } } });
    receive({ payload: { type: 'over', position: { x: 22, y: 44 } } });
    receive({ payload: { type: 'drop', paths: ['/outside/a.md'], position: { x: 24, y: 48 } } });
    receive({ payload: { type: 'leave' } });
    expect(handler.mock.calls.map(([event]) => event)).toEqual([
      { type: 'enter', paths: ['/outside/a.md'], position: { x: 10, y: 20 } },
      { type: 'over', position: { x: 11, y: 22 } },
      { type: 'drop', paths: ['/outside/a.md'], position: { x: 12, y: 24 } },
      { type: 'leave' },
    ]);
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: oldRatio });
  });
  it('sends only sheet source cells to the calculation command', async () => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    const sheets = [{ name: 'Budget', cells: [{ row: 1, col: 1, source: '=1+2' }] }];
    invokeSpy.mockResolvedValueOnce([
      {
        ok: true,
        name: 'Budget',
        rows: 1,
        cols: 1,
        cells: [{ row: 1, col: 1, kind: 'number', display: '3' }],
      },
    ]);
    expect(await calculateSheets(sheets)).toMatchObject([{ ok: true, cells: [{ display: '3' }] }]);
    expect(invokeSpy).toHaveBeenLastCalledWith('calculate_sheets', { sheets });
  });
  it('sends the structural grid operation with literal command keys', async () => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    const sheets = [{ name: 'Budget', cells: [] }];
    invokeSpy.mockResolvedValueOnce({ before: [], after: [] });
    expect(await sheetRestructure(sheets, 0, 'insert_columns', 0, 2)).toEqual({
      before: [],
      after: [],
    });
    expect(invokeSpy).toHaveBeenLastCalledWith('sheet_restructure', {
      sheets,
      sheet: 0,
      change: 'insert_columns',
      at: 0,
      count: 2,
    });
  });
  it('passes the optional save version and returns the written hash', async () => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    invokeSpy.mockResolvedValueOnce({ kind: 'file', contentHash: 'new-hash' });
    expect(await saveNote('/vault', 'a.md', 'New body', 'loaded-hash')).toBe('new-hash');
    expect(invokeSpy).toHaveBeenLastCalledWith('save_note', {
      vault: '/vault',
      path: 'a.md',
      body: 'New body',
      expectHash: 'loaded-hash',
    });
    invokeSpy.mockResolvedValueOnce({
      kind: 'governed',
      projectionHash: 'confirmed-projection-hash',
    });
    expect(await saveNote('/vault', 'knowledge/a.md', 'Capture')).toBeNull();
    expect(invokeSpy).toHaveBeenLastCalledWith('save_note', {
      vault: '/vault',
      path: 'knowledge/a.md',
      body: 'Capture',
      expectHash: undefined,
    });
  });
  it('delegates to the mock when not running inside Tauri', async () => {
    const entries = await scanVault('/demo-vault');
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it('invokes Tauri commands when __TAURI_INTERNALS__ is present', async () => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    await scanVault('/my-vault');
    expect(invokeSpy).toHaveBeenCalledWith('scan_vault', { vault: '/my-vault' });
    await updateFrontmatter('/my-vault', 'items/a.md', { status: 'done' });
    expect(invokeSpy).toHaveBeenCalledWith('update_frontmatter', {
      vault: '/my-vault',
      path: 'items/a.md',
      patch: { status: 'done' },
    });
  });
});

/**
 * The watcher's event, bound in the adapter (M53.20): vaultStore asks for it
 * here instead of importing the Tauri event API itself.
 */
describe('listenVaultChanged', () => {
  it('binds nothing in the browser, which has no watcher to emit', async () => {
    const unlisten = await listenVaultChanged(() => undefined);
    expect(listenSpy).not.toHaveBeenCalled();
    expect(() => unlisten()).not.toThrow();
  });

  it('runs the handler on every vault-changed event inside Tauri', async () => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    const unlistenFn = vi.fn();
    listenSpy.mockResolvedValueOnce(unlistenFn);
    const handler = vi.fn();
    const unlisten = await listenVaultChanged(handler);
    expect(listenSpy).toHaveBeenCalledWith('vault-changed', expect.any(Function));
    const onEvent = listenSpy.mock.calls[0][1] as (event: unknown) => void;
    onEvent({ payload: null });
    onEvent({ payload: null });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(unlisten).toBe(unlistenFn);
  });
});

/**
 * `canPickFiles` is not cosmetic (M16.13c): a browser build has no native
 * picker, and `pickFiles` returning [] there is indistinguishable from the
 * user cancelling. The Files field branches on this to decide between
 * offering the typed-path fallback and doing nothing at all.
 */
/** Page comments (M70.2): six commands with literal payloads, and the
 * watcher's second event. */
/** M60.6: one change is one apply_batch call, its ops passed whole; the
 * open answers what it put back. */
describe('batch IPC (M60.6)', () => {
  it('sends apply_batch and start_watcher their literal payloads inside Tauri', async () => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    const ops = [
      { op: 'patch' as const, path: 'records/a.md', set: { status: 'done' } },
      { op: 'delete' as const, path: 'records/b.md', expectHash: 'a'.repeat(64) },
    ];
    await applyBatch('/my-vault', ops);
    await startWatcher('/my-vault');
    expect(invokeSpy.mock.calls).toEqual([
      ['apply_batch', { vault: '/my-vault', ops }],
      ['start_watcher', { vault: '/my-vault' }],
    ]);
  });

  it('goes to the mock outside Tauri', async () => {
    expect(await startWatcher('/demo-vault')).toEqual({ unfinished: 0, restored: 0, kept: 0 });
    expect(await applyBatch('/demo-vault', [])).toEqual({ batchId: '', files: [] });
    expect(invokeSpy).not.toHaveBeenCalled();
  });
});

describe('page comment IPC', () => {
  it('sends each command its literal payload inside Tauri', async () => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    const v = '/my-vault';
    const path = 'notes/plan.md';
    const anchor = { quote: 'after the freeze', occurrence: 2, before: 'a', after: 'b' };
    await listComments(v, path);
    await startCommentThread(v, path, anchor, 'Hm?');
    await startCommentThread(v, path, null, 'The page.');
    await replyToCommentThread(v, path, 't1', 'Yes.');
    await setCommentThreadResolved(v, path, 't1', true);
    await deleteComment(v, path, 't1', 'c2');
    await deleteCommentThread(v, path, 't1');
    expect(invokeSpy.mock.calls).toEqual([
      ['list_comments', { vault: v, path }],
      ['start_comment_thread', { vault: v, path, anchor, body: 'Hm?' }],
      ['start_comment_thread', { vault: v, path, anchor: null, body: 'The page.' }],
      ['reply_to_comment_thread', { vault: v, path, thread: 't1', body: 'Yes.' }],
      ['set_comment_thread_resolved', { vault: v, path, thread: 't1', resolved: true }],
      ['delete_comment', { vault: v, path, thread: 't1', comment: 'c2' }],
      ['delete_comment_thread', { vault: v, path, thread: 't1' }],
    ]);
  });

  it('listenCommentsChanged binds nothing in the browser', async () => {
    const unlisten = await listenCommentsChanged(() => undefined);
    expect(listenSpy).not.toHaveBeenCalled();
    expect(() => unlisten()).not.toThrow();
  });

  it('listenCommentsChanged hands over the named pages, or null for all, inside Tauri', async () => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    listenSpy.mockResolvedValueOnce(vi.fn());
    const handler = vi.fn();
    await listenCommentsChanged(handler);
    expect(listenSpy).toHaveBeenCalledWith('comments-changed', expect.any(Function));
    const onEvent = listenSpy.mock.calls[0][1] as (event: unknown) => void;
    onEvent({ payload: { pages: ['notes/plan.md'] } });
    onEvent({ payload: { pages: null } });
    expect(handler.mock.calls).toEqual([[['notes/plan.md']], [null]]);
  });
});

describe('attachment IPC', () => {
  it('passes bytes and a display name through the bounded attachment door', async () => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    await importAttachmentBytes('/my-vault', 'image.png', 'AQID');
    expect(invokeSpy).toHaveBeenCalledWith('import_attachment_bytes', {
      vault: '/my-vault',
      name: 'image.png',
      bytesBase64: 'AQID',
    });
  });

  it('reports no native picker outside Tauri, and one inside it', () => {
    expect(canPickFiles()).toBe(false);
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    expect(canPickFiles()).toBe(true);
  });

  it('passes the absolute source through and lets the backend choose the folder', async () => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    await importAttachment('/my-vault', '/Users/me/report.pdf');
    expect(invokeSpy).toHaveBeenCalledWith('import_attachment', {
      vault: '/my-vault',
      source: '/Users/me/report.pdf',
    });
  });
});

// M21.7 parity: the command exists on both sides; the browser mock has no
// ledger and says so with null — never with guard logic.
describe('ledger head IPC', () => {
  it('returns null from the mock outside Tauri', async () => {
    expect(await ledgerHead('/demo-vault')).toBeNull();
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it('invokes ledger_head inside Tauri', async () => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    await ledgerHead('/my-vault');
    expect(invokeSpy).toHaveBeenCalledWith('ledger_head', { vault: '/my-vault' });
  });
});

// M26.4j parity: the command exists on both sides, and the mock's `null` is
// the SAME answer the real backend gives a vault whose ambient ingest has
// never run. Simulating a scheduler here would be a second implementation of
// a durable Rust table — and it would let a browser test claim a queue state
// no database ever held.
describe('ingest item state IPC', () => {
  it('returns null from the mock outside Tauri', async () => {
    expect(await ingestItemState('/demo-vault', 'records/a.md')).toBeNull();
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it('invokes ingest_item_state inside Tauri', async () => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    await ingestItemState('/my-vault', 'records/a.md');
    expect(invokeSpy).toHaveBeenCalledWith('ingest_item_state', {
      vault: '/my-vault',
      path: 'records/a.md',
    });
  });
});

// M21.8 parity: same rule as ledger_head — the command exists on both
// sides; the mock's answer is the fixed no-ledger verdict.
describe('ledger status IPC', () => {
  it('returns the fixed no-ledger verdict from the mock outside Tauri', async () => {
    const status = await ledgerStatus('/demo-vault');
    expect(status.verdict).toBe('no-ledger');
    expect(status.seq).toBeNull();
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it('invokes ledger_status inside Tauri', async () => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    await ledgerStatus('/my-vault');
    expect(invokeSpy).toHaveBeenCalledWith('ledger_status', { vault: '/my-vault' });
  });
});

describe('asking the base a question (M26.5e)', () => {
  const use = {
    kind: 'operational_decision',
    stakes: 'MEDIUM',
    predicate_class: null,
    description: 'whether to hold the release meeting',
  } as const;

  it('refuses in the browser rather than inventing an answer', async () => {
    // A made-up answer would carry a made-up manifest, and every ref in it
    // would cite evidence that never existed — the exact failure the whole
    // manifest apparatus exists to make impossible.
    const asked = await askQuestion('/demo-vault', 'Is the cutover on track?', [], use);
    expect(asked.state).toBe('refused');
    expect(asked).toMatchObject({ code: 'retrieval_unavailable' });
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it('passes the question, the claimed spellings, and the use through to Rust', async () => {
    // The spellings matter: they change what the search reaches, and they are
    // part of the assembly id on the Rust side.
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    await askQuestion('/my-vault', 'Is the cutover on track?', ['Falcon'], use);
    expect(invokeSpy).toHaveBeenCalledWith('ask_question', {
      vault: '/my-vault',
      question: 'Is the cutover on track?',
      aliases: ['Falcon'],
      intendedUse: use,
    });
  });
});

/**
 * The diagnostic log's one door (M53.24). It must never reject: the reporter
 * forwards unhandled rejections, so a report that failed loudly would be
 * reported again, forever.
 */
describe('logFrontend', () => {
  const entry = {
    level: 'error',
    message: 'Uncaught Error: probe',
    source: 'index.js:1:2',
  } as const;

  it('invokes log_frontend with the entry inside Tauri', async () => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    await logFrontend(entry);
    expect(invokeSpy).toHaveBeenCalledWith('log_frontend', { entry });
  });

  it('resolves even when the invoke rejects', async () => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    invokeSpy.mockRejectedValueOnce(new Error('command log_frontend not found'));
    await expect(logFrontend(entry)).resolves.toBeUndefined();
    expect(invokeSpy).toHaveBeenCalledTimes(1);
  });

  it('resolves through the mock outside Tauri', async () => {
    await expect(logFrontend(entry)).resolves.toBeUndefined();
    expect(invokeSpy).not.toHaveBeenCalled();
  });
});

/**
 * Open with's four doors (M55.9). The desktop ones exist only in the app;
 * the clipboard is pbcopy there and the browser's own clipboard here.
 */
describe('Open with IPC', () => {
  const tauri = () => ((window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {});

  it('knows whether it can reach the desktop', () => {
    expect(canOpenOutside()).toBe(false);
    tauri();
    expect(canOpenOutside()).toBe(true);
  });

  it('invokes each command with its keys inside Tauri', async () => {
    tauri();
    await revealInFinder('/my-vault', 'notes/a.md');
    expect(invokeSpy).toHaveBeenCalledWith('reveal_in_finder', {
      vault: '/my-vault',
      path: 'notes/a.md',
    });
    await openInDefaultApp('/my-vault', 'notes/a.md');
    expect(invokeSpy).toHaveBeenCalledWith('open_in_default_app', {
      vault: '/my-vault',
      path: 'notes/a.md',
    });
    invokeSpy.mockResolvedValueOnce('too_long');
    expect(await openAgentLink('zed', 'hi')).toBe('too_long');
    expect(invokeSpy).toHaveBeenCalledWith('open_agent_link', { target: 'zed', prompt: 'hi' });
    await writeClipboard('caf\u00e9');
    expect(invokeSpy).toHaveBeenCalledWith('write_clipboard', { text: 'caf\u00e9' });
  });

  it('refuses the desktop doors in the browser, and copies through its clipboard', async () => {
    await expect(revealInFinder('/v', 'a.md')).rejects.toThrow('Desktop app only');
    await expect(openInDefaultApp('/v', 'a.md')).rejects.toThrow('Desktop app only');
    await expect(openAgentLink('zed', 'hi')).rejects.toThrow('Desktop app only');
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      await writeClipboard('notes/a.md');
      expect(writeText).toHaveBeenCalledWith('notes/a.md');
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
      await expect(writeClipboard('x')).rejects.toThrow();
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
    expect(invokeSpy).not.toHaveBeenCalled();
  });
});

/** A promise settled from outside. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let pending microtasks and one macrotask run. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * The page writes a quit waits for (M55.10): the editor's save, a property
 * commit and a title commit.
 */
describe('page writes', () => {
  const tauri = () => ((window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {});
  afterEach(() => {
    invokeSpy.mockReset();
    invokeSpy.mockImplementation(async () => [] as unknown);
    __resetPageWrites();
  });

  it('settles after an in-flight save and a write started while it waits', async () => {
    tauri();
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    invokeSpy.mockImplementationOnce(() => first.promise);
    invokeSpy.mockImplementationOnce(() => second.promise);
    const save = saveNote('/v', 'a.md', 'body');
    let settled: boolean | undefined;
    const settling = settlePageWrites(2_000).then((value) => (settled = value));
    await tick();
    expect(settled).toBeUndefined();
    const title = setNoteTitle('/v', 'a.md', 'Title');
    first.resolve({ kind: 'file', contentHash: 'written-body-hash' });
    await save;
    await tick();
    await tick();
    expect(settled, 'the title commit is still in flight').toBeUndefined();
    second.resolve(undefined);
    await title;
    expect(await settling).toBe(true);
    expect(invokeSpy).toHaveBeenCalledWith('save_note', {
      vault: '/v',
      path: 'a.md',
      body: 'body',
    });
  });

  it('settles at once with nothing in flight', async () => {
    expect(await settlePageWrites(1_000)).toBe(true);
  });

  it('still rejects a failed write to its caller, and counts it', async () => {
    tauri();
    const before = pageWriteFailures();
    invokeSpy.mockImplementationOnce(async () => {
      throw new Error('disk full');
    });
    await expect(updateFrontmatter('/v', 'a.md', { status: 'done' })).rejects.toThrow('disk full');
    expect(await settlePageWrites(1_000)).toBe(true);
    expect(pageWriteFailures()).toBe(before + 1);
  });

  it('gives up on a hung write at the budget', async () => {
    tauri();
    invokeSpy.mockImplementationOnce(() => new Promise<unknown>(() => undefined));
    void saveNote('/v', 'a.md', 'never lands');
    expect(await settlePageWrites(30)).toBe(false);
  });

  it('tracks the browser branch too', async () => {
    const before = pageWriteFailures();
    await expect(saveNote('/v', '../outside.md', 'x')).rejects.toThrow();
    expect(pageWriteFailures()).toBe(before + 1);
  });
});

/** The shell's quit request and the webview's two answers (M55.10). */
describe('quit IPC', () => {
  const tauri = () => ((window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {});

  it('invokes finish_quit and cancel_quit inside Tauri', async () => {
    tauri();
    await finishQuit();
    expect(invokeSpy).toHaveBeenCalledWith('finish_quit', {});
    await cancelQuit();
    expect(invokeSpy).toHaveBeenCalledWith('cancel_quit', {});
  });

  it('listens on cerebro://quit-requested inside Tauri', async () => {
    tauri();
    const unlistenFn = vi.fn();
    listenSpy.mockResolvedValueOnce(unlistenFn);
    const handler = vi.fn();
    const unlisten = await listenQuitRequested(handler);
    expect(listenSpy).toHaveBeenCalledWith('cerebro://quit-requested', expect.any(Function));
    const onEvent = listenSpy.mock.calls[0][1] as (event: unknown) => void;
    onEvent({ payload: { deadlineMs: 5000 } });
    expect(handler).toHaveBeenCalledWith({ deadlineMs: 5000 });
    expect(unlisten).toBe(unlistenFn);
  });

  it('hears the mock in the browser', async () => {
    const handler = vi.fn();
    const unlisten = await listenQuitRequested(handler);
    (window as unknown as { __cerebroMockQuit: (ms?: number) => void }).__cerebroMockQuit(700);
    expect(handler).toHaveBeenCalledWith({ deadlineMs: 700 });
    unlisten();
    expect(listenSpy).not.toHaveBeenCalled();
  });
});

describe('the vault Trash (M60.8)', () => {
  it('sends delete_note, list_trash and restore_from_trash their literal payloads inside Tauri', async () => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    await deleteNote('/v', 'notes/a.md');
    await listTrash('/v');
    await restoreFromTrash('/v', '20261014T093000Z-a1b2');
    expect(invokeSpy.mock.calls).toEqual([
      ['delete_note', { vault: '/v', path: 'notes/a.md' }],
      ['list_trash', { vault: '/v' }],
      ['restore_from_trash', { vault: '/v', stamp: '20261014T093000Z-a1b2' }],
    ]);
  });

  it('uses the mock Trash in the browser', async () => {
    const item = await deleteNote('/demo-vault', 'records/decisions/dec-offline-window-72h.md');
    expect((await listTrash('/demo-vault'))[0]).toEqual(item);
    expect(await restoreFromTrash('/demo-vault', item.stamp)).toBe(item.path);
    expect(invokeSpy).not.toHaveBeenCalled();
  });
});

describe('starter IPC', () => {
  it('passes the vault through each literal command', async () => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    await starterMarker('/empty');
    await installStarterKit('/empty');
    await declineStarterKit('/empty');
    expect(invokeSpy.mock.calls).toEqual([
      ['starter_marker', { vault: '/empty' }],
      ['install_starter_kit', { vault: '/empty' }],
      ['decline_starter_kit', { vault: '/empty' }],
    ]);
  });
});

it('app links use the guarded command spelling and delivered event', async () => {
  (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
  invokeSpy.mockResolvedValueOnce('cerebro://open?path=a.md');
  expect(await appLink('/vault', 'a.md')).toBe('cerebro://open?path=a.md');
  expect(invokeSpy).toHaveBeenLastCalledWith('app_link', { vault: '/vault', path: 'a.md' });
  invokeSpy.mockResolvedValueOnce(null);
  expect(await takeDeepLink()).toBeNull();
  expect(invokeSpy).toHaveBeenLastCalledWith('take_deep_link', {});
  const stop = vi.fn();
  listenSpy.mockResolvedValueOnce(stop);
  const handler = vi.fn();
  expect(await listenDeepLinks(handler)).toBe(stop);
  expect(listenSpy.mock.calls[0][0]).toBe('cerebro://deep-link');
  listenSpy.mock.calls[0][1]({ payload: { kind: 'refused', reason: 'no page' } });
  expect(handler).toHaveBeenCalledWith({ kind: 'refused', reason: 'no page' });
});
it('browser app links use the mock and its disposable listener', async () => {
  window.__cerebroPendingDeepLink = { kind: 'open', path: 'a.md', vault: null };
  expect(await takeDeepLink()).toEqual({ kind: 'open', path: 'a.md', vault: null });
  expect(await takeDeepLink()).toBeNull();
  const handler = vi.fn();
  const stop = await listenDeepLinks(handler);
  window.__cerebroDeepLink?.({ kind: 'refused', reason: 'bad' });
  expect(handler).toHaveBeenCalledTimes(1);
  stop();
  window.__cerebroDeepLink?.(null);
  expect(handler).toHaveBeenCalledTimes(1);
  expect(await appLink('/vault', 'a & b.md')).toBe(
    `cerebro://open?vault=${'0'.repeat(32)}&path=a%20%26%20b.md`,
  );
  expect(invokeSpy).not.toHaveBeenCalled();
});

describe('whiteboard IPC', () => {
  it('uses literal command keys and wraps source, written hash and preview result', async () => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    invokeSpy.mockResolvedValueOnce({ content: '{}', hash: 'read-hash' });
    expect(await readCanvasFile('/vault', 'boards/a.canvas')).toEqual({
      ok: true,
      content: '{}',
      hash: 'read-hash',
    });
    expect(invokeSpy).toHaveBeenLastCalledWith('read_canvas_file', {
      vault: '/vault',
      path: 'boards/a.canvas',
    });
    invokeSpy.mockResolvedValueOnce({ hash: 'saved-hash' });
    expect(await saveCanvasFile('/vault', 'boards/a.canvas', '{}')).toEqual({
      ok: true,
      hash: 'saved-hash',
    });
    expect(invokeSpy).toHaveBeenLastCalledWith('save_canvas_file', {
      vault: '/vault',
      path: 'boards/a.canvas',
      content: '{}',
    });
    invokeSpy.mockResolvedValueOnce({ path: 'boards/a-2.canvas', hash: null });
    expect(await createCanvasFile('/vault', 'boards/a.canvas', '{}', 'preview')).toEqual({
      ok: true,
      path: 'boards/a-2.canvas',
      hash: null,
    });
    expect(invokeSpy).toHaveBeenLastCalledWith('create_canvas_file', {
      vault: '/vault',
      path: 'boards/a.canvas',
      content: '{}',
      mode: 'preview',
    });
  });
  it('returns typed refusals while preserving transport and malformed errors', async () => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    const refusal = { code: 'missing', message: 'This whiteboard could not be found or read.' };
    invokeSpy.mockRejectedValueOnce(refusal);
    expect(await readCanvasFile('/vault', 'missing.canvas')).toEqual({ ok: false, refusal });
    invokeSpy.mockRejectedValueOnce(new Error('transport closed'));
    await expect(saveCanvasFile('/vault', 'a.canvas', '{}')).rejects.toThrow('transport closed');
    invokeSpy.mockRejectedValueOnce({ code: 'something_else', message: 'unknown' });
    await expect(readCanvasFile('/vault', 'a.canvas')).rejects.toEqual({
      code: 'something_else',
      message: 'unknown',
    });
  });
});

it('passes mail dismissal scope and normalized input through literal commands', async () => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  const { mailDismissalsRead, mailDismiss, mailUndismiss } = await import('./ipc');
  await mailDismissalsRead('/vault');
  expect(invokeSpy).toHaveBeenLastCalledWith('mail_dismissals_read', { vault: '/vault' });
  await mailDismiss('/vault', 'address', 'Dana@Acme.example');
  expect(invokeSpy).toHaveBeenLastCalledWith('mail_dismiss', {
    vault: '/vault',
    kind: 'address',
    value: 'Dana@Acme.example',
  });
  await mailUndismiss('/vault', 'domain', 'acme.example');
  expect(invokeSpy).toHaveBeenLastCalledWith('mail_undismiss', {
    vault: '/vault',
    kind: 'domain',
    value: 'acme.example',
  });
});
