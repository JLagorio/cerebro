// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommitRun, FileAt, FileCommit, RestoreResult } from '@/engine/git';

vi.mock('@/lib/gitIpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/gitIpc')>();
  return {
    ...actual,
    getFileHistory: vi.fn(async () => [] as FileCommit[]),
    getFileAtCommit: vi.fn(async (): Promise<FileAt> => ({ kind: 'absent' })),
    commitRuns: vi.fn(async () => [] as CommitRun[]),
    getFileDiff: vi.fn(async () => ''),
    getFileDiffAtCommit: vi.fn(async () => 'diff --git a/x b/x\n+line'),
    isGitRepo: vi.fn(async () => true),
    getModifiedFiles: vi.fn(async () => []),
    getConflictFiles: vi.fn(async () => []),
    getConflictMode: vi.fn(async () => 'none'),
    gitRemoteStatus: vi.fn(async () => ({ hasRemote: false })),
    restoreNoteVersion: vi.fn(async (): Promise<RestoreResult> => ({
      unchanged: false,
      before: null,
      restored: 'r'.repeat(40),
      commitError: null,
    })),
  };
});

vi.mock('@/editor/openPages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/editor/openPages')>();
  return {
    ...actual,
    flushOpenPages: vi.fn(async () => undefined),
    announceExternalWrites: vi.fn(async () => undefined),
  };
});

// The preview's editor is BlockNote; its own tests cover it. Here it is the
// body it was handed.
vi.mock('@/editor/LazyMarkdownEditor', () => ({
  LazyMarkdownEditor: ({ markdown, readOnly }: { markdown: string; readOnly?: boolean }) => (
    <div data-testid="preview-editor" data-readonly={readOnly ? 'true' : 'false'}>
      {markdown}
    </div>
  ),
}));

import { announceExternalWrites, flushOpenPages } from '@/editor/openPages';
import { InlineDiff, VERSION_UNREADABLE } from '@/git/InlineDiff';
import { refreshGit, resetGitState } from '@/git/useGit';
import {
  getFileAtCommit,
  getFileDiff,
  getFileDiffAtCommit,
  getFileHistory,
  getModifiedFiles,
  restoreNoteVersion,
} from '@/lib/gitIpc';
import { sha256Hex } from '@/lib/sha256';
import { useReviewNotesStore } from '@/stores/reviewNotesStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/test/factories';

const PATH = 'notes/plan.md';
const OLD = '# Plan\n\nWe ship on Thursdays.\n';
const NEW = '# Plan\n\nWe ship on Fridays.\n';
const HASH = 'a'.repeat(40);
const PARENT = 'p'.repeat(40);

const row = (patch: Partial<FileCommit> = {}): FileCommit => ({
  hash: HASH,
  shortHash: 'aaaaaaa',
  message: 'Move the ship day',
  author: 'Ana Rios',
  date: 1_753_700_000,
  parent: PARENT,
  previousAt: null,
  pathAt: PATH,
  previousPath: null,
  change: 'modified',
  ...patch,
});

/** The page's history holds `commit`; its version reads `after`, its parent `before`. */
function serve(commit: FileCommit, after: string | null, before: string | null = OLD) {
  vi.mocked(getFileHistory).mockResolvedValue([commit]);
  vi.mocked(getFileAtCommit).mockImplementation(async (_v, _p, rev) => {
    const text = rev === commit.hash ? after : before;
    return text === null ? { kind: 'absent' } : { kind: 'text', text };
  });
}

function open(path = PATH, commit: string | null = HASH, current = OLD) {
  useVaultStore.setState({
    vaultPath: '/demo-vault',
    entries: [makeEntry({ path, title: 'Plan', hash: sha256Hex(current) })],
  });
  useUiStore.setState({ diffView: { path, commit }, toasts: [] });
  return render(<InlineDiff path={path} />);
}

describe('InlineDiff as the version lens (M58.4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(cleanup);

  it('opens a version three ways, Changes first', async () => {
    serve(row(), NEW);
    open();
    await waitFor(() =>
      expect(screen.getByTestId('prose-summary').textContent).toBe('Changed 1 block.'),
    );
    expect(screen.getByTestId('version-lens')).toBeTruthy();
    expect(screen.getAllByTestId('prose-ins').map((n) => n.textContent?.trim())).toEqual([
      'Fridays.',
    ]);
    fireEvent.click(screen.getByTestId('version-tab-version'));
    expect((await screen.findByTestId('preview-editor')).textContent).toContain('Fridays');
    expect(screen.getByTestId('preview-editor').dataset.readonly).toBe('true');
    fireEvent.click(screen.getByTestId('version-tab-lines'));
    expect(await screen.findByTestId('diff-view')).toBeTruthy();
  });

  it('says a failed read could not be read, never that nothing changed', async () => {
    vi.mocked(getFileHistory).mockResolvedValue([row()]);
    vi.mocked(getFileAtCommit).mockRejectedValue(new Error('kept no copy'));
    open();
    expect((await screen.findByTestId('section-unavailable')).textContent).toBe(VERSION_UNREADABLE);
    expect(screen.queryByText(/did not change/)).toBeNull();
    vi.mocked(getFileDiffAtCommit).mockRejectedValueOnce(new Error('bad revision'));
    fireEvent.click(screen.getByTestId('version-tab-lines'));
    await waitFor(() =>
      expect(screen.getByTestId('section-unavailable').textContent).toBe(VERSION_UNREADABLE),
    );
  });

  it('reads Lines under the path the version had, the rename as one', async () => {
    serve(row({ pathAt: 'notes/plan.md', previousPath: 'notes/old.md', change: 'renamed' }), NEW);
    open();
    await screen.findByTestId('prose-summary');
    fireEvent.click(screen.getByTestId('version-tab-lines'));
    await screen.findByTestId('diff-view');
    expect(getFileDiffAtCommit).toHaveBeenCalledWith(
      '/demo-vault',
      'notes/plan.md',
      HASH,
      'notes/old.md',
    );
    expect(getFileAtCommit).toHaveBeenCalledWith('/demo-vault', 'notes/old.md', PARENT);
  });

  it('hides Restore for a concept, a removed version and the version the page holds', async () => {
    serve(row({ pathAt: 'knowledge/c.md' }), NEW);
    const concept = open('knowledge/c.md');
    await screen.findByTestId('prose-summary');
    expect(screen.queryByTestId('version-restore')).toBeNull();
    concept.unmount();

    serve(row({ change: 'deleted' }), null);
    const removed = open();
    await screen.findByTestId('prose-summary');
    expect(screen.queryByTestId('version-restore')).toBeNull();
    removed.unmount();

    serve(row(), NEW);
    open(PATH, HASH, NEW);
    await screen.findByTestId('prose-summary');
    expect(screen.getByTestId('version-current').textContent).toBe('This is the current version');
    expect(screen.queryByTestId('version-restore')).toBeNull();
  });

  it('restores on confirm: flushes, restores, announces the page and closes', async () => {
    serve(row(), NEW);
    open(PATH, HASH, OLD);
    fireEvent.click(await screen.findByTestId('version-restore'));
    expect(screen.getByRole('dialog').textContent).toContain('Restore this version?');
    expect(screen.getByRole('dialog').textContent).toContain('What it holds now stays in History.');
    await act(async () => {
      fireEvent.click(screen.getByTestId('restore-confirm'));
    });
    await waitFor(() => expect(useUiStore.getState().diffView).toBeNull());
    expect(vi.mocked(flushOpenPages).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(restoreNoteVersion).mock.invocationCallOrder[0],
    );
    expect(restoreNoteVersion).toHaveBeenCalledWith('/demo-vault', PATH, HASH);
    expect(vi.mocked(announceExternalWrites).mock.calls[0][0]).toEqual([PATH]);
    expect(useUiStore.getState().toasts.map((t) => t.message)).toEqual([
      'Restored Plan. The version it replaced is in History.',
    ]);
  });

  it('stays on a refusal, and says why', async () => {
    serve(row(), NEW);
    vi.mocked(restoreNoteVersion).mockRejectedValueOnce(
      new Error('An agent run is still writing this page. Stop it or let it finish, then restore.'),
    );
    open(PATH, HASH, OLD);
    fireEvent.click(await screen.findByTestId('version-restore'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('restore-confirm'));
    });
    await waitFor(() => expect(useUiStore.getState().toasts).toHaveLength(1));
    expect(useUiStore.getState().toasts[0].message).toBe(
      "Couldn't restore Plan: An agent run is still writing this page. Stop it or let it finish, then restore.",
    );
    expect(useUiStore.getState().diffView).toEqual({ path: PATH, commit: HASH });
    expect(announceExternalWrites).not.toHaveBeenCalled();
  });

  it('closes on Escape, but not past the open confirm', async () => {
    serve(row(), NEW);
    open(PATH, HASH, OLD);
    fireEvent.click(await screen.findByTestId('version-restore'));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(useUiStore.getState().diffView).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useUiStore.getState().diffView).toBeNull();
  });

  it('keeps the working-tree diff when no commit is asked', async () => {
    vi.mocked(getFileDiff).mockResolvedValueOnce('');
    open(PATH, null);
    expect(await screen.findByText('No uncommitted changes to this note.')).toBeTruthy();
    expect(screen.queryByTestId('version-lens')).toBeNull();
    cleanup();
    vi.mocked(getFileDiff).mockRejectedValueOnce(new Error('git exited 128'));
    open(PATH, null);
    expect((await screen.findByTestId('section-unavailable')).textContent).toBe(
      "This page's changes could not be read.",
    );
  });

  const NUMBERED = ['@@ -3,1 +3,1 @@', '-We ship on Thursdays.', '+We ship on Fridays.'].join('\n');

  it('opened from a turn, starts on Lines and takes notes for the agent (M58.5)', async () => {
    serve(row({ pathAt: 'notes/old-plan.md' }), NEW);
    vi.mocked(getFileDiffAtCommit).mockResolvedValue(NUMBERED);
    useVaultStore.setState({
      vaultPath: '/demo-vault',
      entries: [makeEntry({ path: PATH, title: 'Plan', hash: sha256Hex(OLD) })],
    });
    useUiStore.setState({
      diffView: { path: PATH, commit: HASH, review: { conversationId: 'c-1', runId: 'run-1' } },
      toasts: [],
    });
    useReviewNotesStore.setState({ notes: [] });
    render(<InlineDiff path={PATH} />);
    expect(screen.getByTestId('version-tab-lines').getAttribute('aria-selected')).toBe('true');
    const line = await screen.findByRole('button', { name: 'Note on line 3 after the change' });
    fireEvent.click(line);
    fireEvent.change(screen.getByTestId('diff-note-text'), { target: { value: 'Thursday.' } });
    fireEvent.click(screen.getByTestId('diff-note-add'));
    expect(useReviewNotesStore.getState().notes[0]).toMatchObject({
      vault: '/demo-vault',
      conversationId: 'c-1',
      runId: 'run-1',
      commit: HASH,
      path: 'notes/old-plan.md',
      side: 'new',
      start: 3,
    });
    // Changes says where notes go.
    fireEvent.click(screen.getByTestId('version-tab-changes'));
    expect(screen.getByTestId('lens-notes-hint').textContent).toBe(
      'To leave a note for the agent, open Lines.',
    );
  });

  it('keeps a note being typed while a later write re-reads the history (M58.5)', async () => {
    serve(row({ pathAt: 'notes/old-plan.md' }), NEW);
    vi.mocked(getFileDiffAtCommit).mockResolvedValue(NUMBERED);
    resetGitState();
    useVaultStore.setState({
      vaultPath: '/demo-vault',
      entries: [makeEntry({ path: PATH, title: 'Plan', hash: sha256Hex(OLD) })],
    });
    useUiStore.setState({
      diffView: { path: PATH, commit: HASH, review: { conversationId: 'c-1', runId: 'run-1' } },
      toasts: [],
    });
    useReviewNotesStore.setState({ notes: [] });
    render(<InlineDiff path={PATH} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Note on line 3 after the change' }));
    await waitFor(() => expect(getFileHistory).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByTestId('diff-note-text'), { target: { value: 'Thursday.' } });
    const linesReads = vi.mocked(getFileDiffAtCommit).mock.calls.length;

    // A later turn writes the page: it joins git's changed files, and the
    // history is read again, slowly.
    let answer: (rows: FileCommit[]) => void = () => undefined;
    vi.mocked(getFileHistory).mockImplementationOnce(
      () => new Promise<FileCommit[]>((resolve) => (answer = resolve)),
    );
    vi.mocked(getModifiedFiles).mockResolvedValueOnce([
      { path: PATH, status: 'modified', staged: false },
    ]);
    await act(async () => {
      await refreshGit();
    });
    await waitFor(() => expect(getFileHistory).toHaveBeenCalledTimes(2));
    expect((screen.getByTestId('diff-note-text') as HTMLTextAreaElement).value).toBe('Thursday.');
    await act(async () => {
      answer([row({ pathAt: 'notes/old-plan.md' })]);
    });
    expect((screen.getByTestId('diff-note-text') as HTMLTextAreaElement).value).toBe('Thursday.');
    expect(getFileDiffAtCommit).toHaveBeenCalledTimes(linesReads);
    fireEvent.click(screen.getByTestId('diff-note-add'));
    expect(useReviewNotesStore.getState().notes[0]).toMatchObject({
      path: 'notes/old-plan.md',
      start: 3,
      text: 'Thursday.',
    });
    resetGitState();
  });

  it('takes no notes on a diff opened without a turn', async () => {
    serve(row(), NEW);
    vi.mocked(getFileDiffAtCommit).mockResolvedValue(NUMBERED);
    open();
    fireEvent.click(screen.getByTestId('version-tab-lines'));
    expect(await screen.findByTestId('diff-view')).toBeTruthy();
    expect(screen.queryAllByTestId('diff-note-line')).toHaveLength(0);
    expect(screen.queryByTestId('lens-notes-hint')).toBeNull();
  });
});
