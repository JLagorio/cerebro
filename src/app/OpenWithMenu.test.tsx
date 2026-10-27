// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEntry } from '@/test/factories';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import AGENT_LINKS from '../../shared/policy/agent-links.v1.json';

const ipc = vi.hoisted(() => ({
  canOpenOutside: vi.fn(() => true),
  appLink: vi.fn(async (_vault: string, _path: string) => 'cerebro://open?path=plan.md'),
  readNote: vi.fn(async () => ''),
  writeClipboard: vi.fn(async (_text: string) => undefined),
  revealInFinder: vi.fn(async (_vault: string, _path: string) => undefined),
  openInDefaultApp: vi.fn(async (_vault: string, _path: string) => undefined),
  openAgentLink: vi.fn(
    async (_target: string, _prompt: string) => 'opened' as 'opened' | 'too_long' | 'no_app',
  ),
}));
vi.mock('@/lib/ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc')>()),
  ...ipc,
}));
const pages = vi.hoisted(() => ({
  flushOpenPages: vi.fn(async () => ({ outcomes: [], unresolvedOwnerIds: [] })),
}));
vi.mock('@/editor/openPages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/editor/openPages')>()),
  ...pages,
}));

import { OpenWithMenu } from './OpenWithMenu';

const VAULT = '/vault';
const ENTRY = makeEntry({
  path: 'notes/plan.md',
  title: 'Plan',
  properties: { status: 'draft' },
  relationships: { owner: ['Jane'] },
});
const RAW = '---\nstatus: draft\nowner: "[[Jane]]"\n---\n# Plan\n\nTyped a moment ago.\n';

const toasts = () => useUiStore.getState().toasts.map((t) => t.message);

/** A promise and the hands that settle it. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function openMenu(knowledgeFile = false) {
  cleanup();
  render(<OpenWithMenu entry={ENTRY} knowledgeFile={knowledgeFile} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open with' }));
}

const pick = (testId: string) => fireEvent.click(screen.getByTestId(testId));

beforeEach(() => {
  // Reset, not clear: a once-value a failed test left queued must not leak.
  for (const fn of [...Object.values(ipc), ...Object.values(pages)]) fn.mockReset();
  ipc.canOpenOutside.mockReturnValue(true);
  ipc.appLink.mockResolvedValue('cerebro://open?path=plan.md');
  ipc.readNote.mockResolvedValue(RAW);
  ipc.writeClipboard.mockResolvedValue(undefined);
  ipc.revealInFinder.mockResolvedValue(undefined);
  ipc.openInDefaultApp.mockResolvedValue(undefined);
  ipc.openAgentLink.mockResolvedValue('opened');
  pages.flushOpenPages.mockResolvedValue({ outcomes: [], unresolvedOwnerIds: [] });
  useVaultStore.setState({ vaultPath: VAULT, entries: [ENTRY] });
  useUiStore.setState({ toasts: [] });
});
afterEach(cleanup);

describe('Copy as prompt', () => {
  it('flushes before it reads, and copies the built prompt', async () => {
    openMenu();
    pick('open-with-copy-prompt');
    await waitFor(() => expect(toasts()).toEqual(['Prompt copied']));
    expect(pages.flushOpenPages.mock.invocationCallOrder[0]).toBeLessThan(
      ipc.readNote.mock.invocationCallOrder[0],
    );
    expect(ipc.readNote).toHaveBeenCalledWith(VAULT, 'notes/plan.md');
    const prompt = ipc.writeClipboard.mock.calls[0][0];
    expect(prompt).toContain('Title: Plan');
    expect(prompt).toContain('Path: notes/plan.md');
    expect(prompt).toContain('status: draft');
    expect(prompt).toContain('"[[Jane]]"');
    expect(prompt).toContain('<page>\n# Plan\n\nTyped a moment ago.\n</page>');
    expect(prompt).not.toContain('---');
  });

  it('says nothing while the clipboard write is pending, and copied once it lands', async () => {
    const write = deferred<undefined>();
    ipc.writeClipboard.mockReturnValueOnce(write.promise);
    openMenu();
    pick('open-with-copy-prompt');
    await waitFor(() => expect(ipc.writeClipboard).toHaveBeenCalled());
    expect(toasts()).toEqual([]);
    await act(async () => write.resolve(undefined));
    expect(toasts()).toEqual(['Prompt copied']);
  });

  it('says it could not copy when the write fails', async () => {
    ipc.writeClipboard.mockRejectedValueOnce(new Error('denied'));
    openMenu();
    pick('open-with-copy-prompt');
    await waitFor(() => expect(toasts()).toEqual(["Couldn't copy the prompt"]));
  });
});

describe('Copy path', () => {
  it('copies the vault-relative path', async () => {
    openMenu();
    pick('open-with-copy-path');
    await waitFor(() => expect(toasts()).toEqual(['Path copied']));
    expect(ipc.writeClipboard).toHaveBeenCalledWith('notes/plan.md');
    ipc.writeClipboard.mockRejectedValueOnce(new Error('denied'));
    openMenu();
    pick('open-with-copy-path');
    await waitFor(() => expect(toasts()).toContain("Couldn't copy the path"));
  });
});

describe('the desktop actions', () => {
  it('reveal in Finder, and toast a refusal in its own words', async () => {
    openMenu();
    pick('open-with-reveal');
    await waitFor(() => expect(ipc.revealInFinder).toHaveBeenCalledWith(VAULT, 'notes/plan.md'));
    expect(toasts()).toEqual([]);
    ipc.revealInFinder.mockRejectedValueOnce('notes/plan.md is not a file in the vault');
    openMenu();
    pick('open-with-reveal');
    await waitFor(() => expect(toasts()).toEqual(['notes/plan.md is not a file in the vault']));
  });

  it('open the default editor only after the pages flush', async () => {
    openMenu();
    pick('open-with-default-editor');
    await waitFor(() => expect(ipc.openInDefaultApp).toHaveBeenCalledWith(VAULT, 'notes/plan.md'));
    expect(pages.flushOpenPages.mock.invocationCallOrder[0]).toBeLessThan(
      ipc.openInDefaultApp.mock.invocationCallOrder[0],
    );
    ipc.openInDefaultApp.mockRejectedValueOnce(new Error('No app is set to open Markdown files'));
    openMenu();
    pick('open-with-default-editor');
    await waitFor(() => expect(toasts()).toEqual(['No app is set to open Markdown files']));
  });

  it('are disabled in the browser, and say why', () => {
    ipc.canOpenOutside.mockReturnValue(false);
    openMenu();
    for (const id of [
      'open-with-reveal',
      'open-with-default-editor',
      ...AGENT_LINKS.targets.map((t) => `open-with-agent-${t.id}`),
    ]) {
      const item = screen.getByTestId(id);
      expect(item.hasAttribute('disabled'), id).toBe(true);
      expect(item.textContent).toContain('Desktop app only');
    }
    // The copies need no desktop.
    expect(screen.getByTestId('open-with-copy-prompt').hasAttribute('disabled')).toBe(false);
    expect(screen.getByTestId('open-with-copy-path').hasAttribute('disabled')).toBe(false);
  });

  it('leave the default editor off a knowledge page', () => {
    openMenu(true);
    expect(screen.queryByTestId('open-with-default-editor')).toBeNull();
    expect(screen.getByTestId('open-with-reveal')).toBeTruthy();
  });
});

describe('Hand off to', () => {
  it('lists the targets in the artifact’s order', () => {
    openMenu();
    const items = screen
      .getAllByRole('menuitem')
      .filter((el) => el.dataset.testid?.startsWith('open-with-agent-'));
    expect(items.map((el) => el.textContent)).toEqual(AGENT_LINKS.targets.map((t) => t.label));
    expect(items.map((el) => el.textContent)).toEqual([
      'Claude Code on the web',
      'Codex',
      'Cursor',
      'Zed',
    ]);
  });

  it('opens the app and says nothing when the link opens', async () => {
    openMenu();
    pick('open-with-agent-codex');
    await waitFor(() => expect(ipc.openAgentLink).toHaveBeenCalled());
    const [target, prompt] = ipc.openAgentLink.mock.calls[0];
    expect(target).toBe('codex');
    expect(prompt).toContain('Path: notes/plan.md');
    await act(async () => undefined);
    expect(ipc.writeClipboard).not.toHaveBeenCalled();
    expect(toasts()).toEqual([]);
  });

  it('copies instead when the link is too long', async () => {
    ipc.openAgentLink.mockResolvedValueOnce('too_long');
    openMenu();
    pick('open-with-agent-cursor');
    await waitFor(() =>
      expect(toasts()).toEqual([
        'Too long for a link, so the prompt is copied. Paste it into Cursor.',
      ]),
    );
    expect(ipc.writeClipboard.mock.calls[0][0]).toBe(ipc.openAgentLink.mock.calls[0][1]);
  });

  it('copies instead when nothing opens the link', async () => {
    ipc.openAgentLink.mockResolvedValueOnce('no_app');
    openMenu();
    pick('open-with-agent-zed');
    await waitFor(() => expect(toasts()).toEqual(["Zed didn't open, so the prompt is copied."]));
    expect(ipc.writeClipboard).toHaveBeenCalledTimes(1);
  });

  it('says both failed when the copy fails too', async () => {
    ipc.openAgentLink.mockResolvedValueOnce('no_app');
    ipc.writeClipboard.mockRejectedValueOnce(new Error('denied'));
    openMenu();
    pick('open-with-agent-claude-code-web');
    await waitFor(() =>
      expect(toasts()).toEqual(["Couldn't open Claude Code on the web or copy the prompt."]),
    );
  });
});

describe('Copy Cerebro link', () => {
  it('builds through Rust and toasts only after the clipboard write', async () => {
    const pending = deferred<undefined>();
    ipc.writeClipboard.mockReturnValueOnce(pending.promise);
    openMenu();
    pick('open-with-copy-link');
    await waitFor(() =>
      expect(ipc.writeClipboard).toHaveBeenCalledWith('cerebro://open?path=plan.md'),
    );
    expect(ipc.appLink).toHaveBeenCalledWith(VAULT, ENTRY.path);
    expect(toasts()).toEqual([]);
    await act(async () => pending.resolve(undefined));
    expect(toasts()).toEqual(['Link copied']);
  });
  it('requires the desktop and reports a failed copy without success', async () => {
    ipc.canOpenOutside.mockReturnValue(false);
    openMenu();
    expect(screen.getByTestId('open-with-copy-link').getAttribute('disabled')).not.toBeNull();
    expect(screen.getByTestId('open-with-copy-link').textContent).toContain('Desktop app only');
    ipc.canOpenOutside.mockReturnValue(true);
    ipc.appLink.mockRejectedValueOnce('Link unavailable');
    openMenu();
    pick('open-with-copy-link');
    await waitFor(() => expect(toasts()).toEqual(['Link unavailable']));
  });
});
