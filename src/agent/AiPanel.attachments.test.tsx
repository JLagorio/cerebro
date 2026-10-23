import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AgentEvent } from './types';

vi.mock('./agentIpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agentIpc')>();
  return {
    ...actual,
    runAgent: vi.fn(async () => ({ run: 9, durableId: 'attach-9', attach: 'attach-9' })),
    attachRun: vi.fn(async (_handle, _after, _deliver: (event: AgentEvent) => void) => ({
      state: 'held',
      done: false,
      detach: vi.fn(),
    })),
    stopAgent: vi.fn(async () => true),
    listInteractions: vi.fn(async () => []),
    readCliTranscript: vi.fn(async () => ({
      state: 'unavailable',
      reason: 'not_recorded',
      retention_days: 30,
    })),
    agentContextUsage: vi.fn(async () => ({ state: 'not_recorded' })),
  };
});

// The attachment doors, as the mock backend answers them, watched.
vi.mock('@/lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc')>();
  return {
    ...actual,
    importAttachment: vi.fn(actual.importAttachment),
    importAttachmentBytes: vi.fn(actual.importAttachmentBytes),
    deleteNote: vi.fn(actual.deleteNote),
  };
});

import { AiPanel } from './AiPanel';
import * as agentIpc from './agentIpc';
import { forgetDraftsInMemory } from './drafts';
import { FILE_WORDS } from './elements/attachments';
import * as ipc from '@/lib/ipc';
import { mockDrop, type DroppedSeed } from '@/lib/mockDropped';
import { resetMockFs } from '@/lib/mockIpc';
import { fixtureVault } from '@/test/factories';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * Composer attachments, through the panel (M91.17): a file from outside the
 * vault waits on the composer, is copied into attachments/ through the human
 * doors when the message is sent (CV-56), and the turn's system prompt names
 * it by its vault path and kind with what opens it. One Undo moves the
 * send's new copies to the Trash; a copy that fails sends nothing and keeps
 * the draft (CV-03).
 */

const PDF = 'JVBERi0xLjcK';

const input = () => screen.getByLabelText('Message the assistant') as HTMLTextAreaElement;
const pill = () => screen.getByTestId('chat-composer');
const attachments = () => screen.queryAllByTestId('composer-attachment');

/** Drop `files` on the composer, as a native drag reaches it. */
async function dropOnComposer(files: DroppedSeed[]) {
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: () => input(),
  });
  await act(async () => mockDrop({ at: { x: 10, y: 10 }, files }));
}

/** Type `text` and send it with Enter. */
function send(text: string) {
  fireEvent.change(input(), { target: { value: text } });
  fireEvent.keyDown(input(), { key: 'Enter' });
}

const sentPrompt = () =>
  (vi.mocked(agentIpc.runAgent).mock.calls[0][1] as { systemPrompt: string }).systemPrompt;

const toasts = () => useUiStore.getState().toasts;

beforeEach(() => {
  localStorage.clear();
  forgetDraftsInMemory();
  resetMockFs();
  vi.clearAllMocks();
  Element.prototype.scrollTo ??= () => {};
  useVaultStore.setState({ vaultPath: '/demo-vault', entries: fixtureVault(), views: [] });
  useNavStore.setState({ selection: { kind: 'home' } });
  useUiStore.setState({
    aiPanelOpen: true,
    aiPanelPresentation: 'panel',
    aiPanelMinimized: false,
    panelConversation: null,
    panelAgents: { '/demo-vault': null },
    handoffs: [],
    runs: [],
    detailPath: null,
    toasts: [],
  });
});

afterEach(cleanup);

describe('a file dropped on the composer', () => {
  it('waits there, copied in nothing until the message is sent', async () => {
    render(<AiPanel presentation="panel" />);
    await act(async () => {});
    await dropOnComposer([{ path: '/outside/report.pdf', base64: PDF }]);
    await waitFor(() => expect(attachments()).toHaveLength(1));
    const [chip] = attachments();
    expect(chip.dataset.state).toBe('idle');
    expect(within(chip).getByText('report.pdf')).toBeTruthy();
    expect(within(chip).getByText(`PDF · ${FILE_WORDS.waiting}`)).toBeTruthy();
    expect(pill().contains(chip)).toBe(true);
    expect(vi.mocked(ipc.importAttachment)).not.toHaveBeenCalled();
  });

  it('waits once, however many times the same file arrives', async () => {
    render(<AiPanel presentation="panel" />);
    await act(async () => {});
    await dropOnComposer([
      { path: '/outside/report.pdf', base64: PDF },
      { path: '/outside/report.pdf', base64: PDF },
    ]);
    await waitFor(() => expect(attachments()).toHaveLength(1));
    await dropOnComposer([{ path: '/outside/report.pdf', base64: PDF }]);
    await act(async () => {});
    expect(attachments()).toHaveLength(1);
  });

  it('names what it could not take, and never lets it wait', async () => {
    render(<AiPanel presentation="panel" />);
    await act(async () => {});
    await dropOnComposer([
      { path: '/outside/folder', folder: true },
      { path: '/outside/.secret.pdf', base64: PDF },
    ]);
    await waitFor(() =>
      expect(toasts().map((t) => t.message)).toEqual([
        'Skipped folder (a folder), .secret.pdf (a hidden file)',
      ]),
    );
    expect(attachments()).toHaveLength(0);
  });
});

describe('sending a message with an attached file', () => {
  it('copies it in first, and the turn’s prompt names its vault path, its kind and its reader', async () => {
    render(<AiPanel presentation="panel" />);
    await act(async () => {});
    await dropOnComposer([{ path: '/outside/report.pdf', base64: PDF }]);
    await waitFor(() => expect(attachments()).toHaveLength(1));
    send('What does the report say?');
    await waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledOnce());
    expect(vi.mocked(ipc.importAttachment)).toHaveBeenCalledOnce();
    expect(vi.mocked(ipc.importAttachment)).toHaveBeenCalledWith(
      '/demo-vault',
      '/outside/report.pdf',
    );
    const prompt = sentPrompt();
    // The snapshot lists it by vault path and kind…
    const snapshot = JSON.parse(
      prompt.slice(prompt.indexOf('```json') + 7, prompt.lastIndexOf('```')),
    );
    expect(snapshot.attachedFiles).toEqual([{ path: 'attachments/report.pdf', kind: 'pdf' }]);
    // …and the panel's run holds Claude Code's Read, which opens a PDF.
    expect(prompt).toContain(
      'The person attached `attachments/report.pdf`: open it with your Read tool.',
    );
    expect(prompt).not.toContain('/outside/');
    // The chip now names the copy.
    const [chip] = attachments();
    expect(chip.dataset.state).toBe('done');
    expect(chip.dataset.path).toBe('attachments/report.pdf');
    expect(input().value).toBe('');
  });

  it('is one Undo, which moves every new copy it made to the Trash', async () => {
    render(<AiPanel presentation="panel" />);
    await act(async () => {});
    await dropOnComposer([
      { path: '/outside/report.pdf', base64: PDF },
      { path: '/outside/notes.txt', content: 'Plain words.' },
    ]);
    await waitFor(() => expect(attachments()).toHaveLength(2));
    send('Compare these');
    await waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledOnce());
    const added = toasts().filter((t) => t.action !== undefined);
    expect(added.map((t) => [t.message, t.action?.label])).toEqual([
      ['Added 2 files to attachments/', 'Undo'],
    ]);
    await act(async () => added[0].action?.run());
    await waitFor(() => expect(attachments()).toHaveLength(0));
    expect(vi.mocked(ipc.deleteNote).mock.calls.map(([, path]) => path)).toEqual([
      'attachments/report.pdf',
      'attachments/notes.txt',
    ]);
    expect(toasts().at(-1)?.message).toBe('Undid: Added 2 files to attachments/');
  });

  it('keeps the draft, sends nothing and says why when a copy fails', async () => {
    vi.mocked(ipc.importAttachment).mockRejectedValueOnce(
      new Error('report.pdf could not be read'),
    );
    render(<AiPanel presentation="panel" />);
    await act(async () => {});
    await dropOnComposer([{ path: '/outside/report.pdf', base64: PDF }]);
    await waitFor(() => expect(attachments()).toHaveLength(1));
    send('What does the report say?');
    await waitFor(() =>
      expect(toasts().map((t) => t.message)).toContain(
        "Couldn't add report.pdf — report.pdf could not be read. Nothing was sent.",
      ),
    );
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();
    expect(input().value).toBe('What does the report say?');
    const [chip] = attachments();
    expect(chip.dataset.state).toBe('error');
    expect(within(chip).getByText('report.pdf could not be read')).toBeTruthy();
    // Sent again, the copy goes through and the message with it.
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledOnce());
    expect(sentPrompt()).toContain('`attachments/report.pdf`');
  });

  it('takes a file off before it is sent, and copies nothing for it', async () => {
    render(<AiPanel presentation="panel" />);
    await act(async () => {});
    await dropOnComposer([{ path: '/outside/report.pdf', base64: PDF }]);
    await waitFor(() => expect(attachments()).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Remove report.pdf from context' }));
    expect(attachments()).toHaveLength(0);
    send('Never mind the report');
    await waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledOnce());
    expect(vi.mocked(ipc.importAttachment)).not.toHaveBeenCalled();
    expect(sentPrompt()).not.toContain('attachedFiles');
  });
});

describe('the context chips beside a file', () => {
  it('keep their ids, names and summary: a file is an Attachment, never a context chip', async () => {
    useUiStore.setState({ aiPanelPresentation: 'floating' });
    render(<AiPanel presentation="floating" />);
    await act(async () => {});
    await dropOnComposer([{ path: '/outside/report.pdf', base64: PDF }]);
    await waitFor(() => expect(attachments()).toHaveLength(1));
    // The floating summary still names the places and records alone.
    const summary = within(pill()).getByRole('button', { name: /^Context:/ });
    expect(summary.getAttribute('aria-label')).toBe('Context: Home');
    fireEvent.click(summary);
    const chips = await screen.findAllByTestId('context-chip');
    expect(chips.map((chip) => chip.dataset.kind)).toEqual(['place']);
    expect(screen.getByRole('button', { name: 'Remove Home from context' })).toBeTruthy();
  });

  it('give the Context reading a tab stop of its own', async () => {
    render(<AiPanel presentation="panel" />);
    await act(async () => {});
    expect(screen.getByTestId('context-use').getAttribute('tabindex')).toBe('0');
  });
});
