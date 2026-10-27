import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const handlers: Array<(event: unknown) => void> = [];
vi.mock('@/agent/agentIpc', () => ({
  runAgent: vi.fn(async () => ({ run: 1, durableId: null })),
  // The real narrowing (M34.2.4): a scripted deferral must throw here the
  // way production would, not slip through a permissive stub.
  startedOrThrow: (start: { run: number } | { deferred: string[] }) => {
    if ('deferred' in start) throw new Error(`run deferred: ${start.deferred.join(', ')}`);
    return start;
  },
  onAgentEvent: vi.fn((handler: (event: unknown) => void) => {
    handlers.push(handler);
    return () => {
      const i = handlers.indexOf(handler);
      if (i >= 0) handlers.splice(i, 1);
    };
  }),
}));

import * as agentIpc from '@/agent/agentIpc';
import * as ipc from '@/lib/ipc';
import { makeEntry } from '@/engine/testHelpers';
import { AskAiPopover } from './AskAiPopover';
import { useVaultStore } from '@/stores/vaultStore';

afterEach(cleanup);

/**
 * M17.16 — the decision surface, end to end.
 *
 * The engine is tested in engine/hunks.test.ts; this is about the two things
 * only the component can get wrong: what the run is allowed to do, and what
 * happens to the document when the user decides.
 */
const PASSAGE = 'The pricing is annual and the trial is short.';
const REWRITE = 'The pricing is monthly and the trial is short.';

const reply = (text: string) =>
  act(() => {
    for (const handler of [...handlers]) handler({ run: 1, kind: 'Result', text });
    for (const handler of [...handlers]) handler({ run: 1, kind: 'Done' });
  });

describe('AskAiPopover', () => {
  let onReplace: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    handlers.length = 0;
    vi.mocked(agentIpc.runAgent).mockClear();
    useVaultStore.setState({ vaultPath: '/vault', entries: [] });
    onReplace = vi.fn(() => ({ kind: 'applied' as const }));
  });

  const open = () =>
    render(<AskAiPopover selection={PASSAGE} onReplace={onReplace} onClose={() => undefined} />);

  const ask = async () => {
    fireEvent.change(screen.getByLabelText(/What should the assistant do/), {
      target: { value: 'make it monthly' },
    });
    fireEvent.keyDown(screen.getByLabelText(/What should the assistant do/), { key: 'Enter' });
    await waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
  };

  it('grants the run NO tools at all', async () => {
    // A rewrite is a text transformation. Giving it the vault would let it
    // wander, and open_note would navigate the user away from the paragraph
    // they are editing. Rust honours [] as "narrow to nothing" (M17.8).
    open();
    await ask();
    expect(vi.mocked(agentIpc.runAgent).mock.calls[0][1]).toMatchObject({
      allowedTools: [],
      shell: 'off',
      connectors: false,
    });
  });

  it('sends the passage, not the whole document', async () => {
    open();
    await ask();
    const sent = vi.mocked(agentIpc.runAgent).mock.calls[0][1].message;
    expect(sent).toContain(PASSAGE);
    expect(sent).toContain('make it monthly');
  });

  it('applies what was accepted, and starts with everything accepted', async () => {
    // The user asked for the change; the default should be the thing they
    // asked for, with rejection as the correction.
    open();
    await ask();
    reply(REWRITE);
    await screen.findByTestId('ask-ai-hunks');
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onReplace).toHaveBeenCalledWith(REWRITE);
  });

  it('leaves the passage byte-identical when every change is rejected', async () => {
    open();
    await ask();
    reply(REWRITE);
    const hunks = await screen.findAllByTestId('ask-ai-hunk');
    for (const hunk of hunks) fireEvent.click(hunk);
    // The button says what it will do — "Apply" over an unchanged passage
    // would be a lie about what the click does.
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    expect(onReplace).toHaveBeenCalledWith(PASSAGE);
  });

  it('Keep mine preserves original whitespace when the reply only changes spacing', async () => {
    open();
    await ask();
    reply(PASSAGE.replace('pricing is', 'pricing   is'));
    await screen.findByText(/left the passage as it was/);
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    expect(onReplace).toHaveBeenCalledWith(PASSAGE);
  });

  it('Keep mine preserves original whitespace after every proposed hunk is rejected', async () => {
    open();
    await ask();
    reply(REWRITE.replace('pricing is', 'pricing   is'));
    const hunks = await screen.findAllByTestId('ask-ai-hunk');
    for (const hunk of hunks) fireEvent.click(hunk);
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    expect(onReplace).toHaveBeenCalledWith(PASSAGE);
  });

  it('takes one change and leaves another', async () => {
    open();
    await ask();
    reply('The pricing is monthly and the trial is generous.');
    const hunks = await screen.findAllByTestId('ask-ai-hunk');
    expect(hunks).toHaveLength(2);
    fireEvent.click(hunks[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onReplace).toHaveBeenCalledWith('The pricing is monthly and the trial is short.');
  });

  it('says so when the assistant changed nothing', async () => {
    // An empty decision list reads as a failure; "it decided nothing needed
    // changing" is a real answer and a common one.
    open();
    await ask();
    reply(PASSAGE);
    expect(await screen.findByText(/left the passage as it was/)).toBeTruthy();
  });

  it('runs a preset straight away, without showing the prompt box', async () => {
    // M18: the toolbar's one-click actions. A preset arrives already decided,
    // so making the user press Enter on a prefilled box would be theatre.
    render(
      <AskAiPopover
        selection={PASSAGE}
        preset="Make it monthly"
        onReplace={onReplace}
        onClose={() => undefined}
      />,
    );
    await waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    expect(vi.mocked(agentIpc.runAgent).mock.calls[0][1].message).toContain('Make it monthly');
  });

  it('sends a preset through the same decision surface as a typed instruction', async () => {
    // The safeguard that matters: a preset is a pre-written instruction, never
    // a shortcut that applies a rewrite without a decision.
    render(
      <AskAiPopover
        selection={PASSAGE}
        preset="Make it monthly"
        onReplace={onReplace}
        onClose={() => undefined}
      />,
    );
    await waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    reply(REWRITE);
    await screen.findByTestId('ask-ai-hunks');
    expect(onReplace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onReplace).toHaveBeenCalledWith(REWRITE);
  });

  it('strips a code fence the model wrapped the answer in', async () => {
    open();
    await ask();
    reply('```\n' + REWRITE + '\n```');
    await screen.findByTestId('ask-ai-hunks');
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onReplace).toHaveBeenCalledWith(REWRITE);
  });
});

/**
 * Its elements (M91.14): the instruction is a Prompt Input, the writing
 * actions are Suggestion rows, the working line carries the AI light only
 * while the rewrite is written, and the decision is a Confirmation holding
 * the hunks and its own answers — each with the ids, names and keyboard
 * path the writing specs drive it by.
 */
describe('AskAiPopover elements', () => {
  beforeEach(() => {
    handlers.length = 0;
    vi.mocked(agentIpc.runAgent).mockClear();
    useVaultStore.setState({ vaultPath: '/vault', entries: [] });
  });

  const open = () =>
    render(
      <AskAiPopover
        selection={PASSAGE}
        onReplace={() => ({ kind: 'applied' })}
        onClose={() => undefined}
      />,
    );
  const field = () =>
    screen.getByLabelText('What should the assistant do with this passage?') as HTMLTextAreaElement;
  const askButton = () => screen.getByRole('button', { name: 'Ask' }) as HTMLButtonElement;

  it('asks through a Prompt Input whose send waits for words', async () => {
    open();
    expect(field().dataset.slot).toBe('prompt-input-textarea');
    expect(field().closest('[data-slot="prompt-input"]')).not.toBeNull();
    expect(document.activeElement).toBe(field());
    // Empty: nothing to send, so the send is out of the Tab order and an
    // Enter asks nothing.
    expect(askButton().disabled).toBe(true);
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();
    fireEvent.change(field(), { target: { value: 'make it monthly' } });
    expect(askButton().disabled).toBe(false);
    expect(askButton().tabIndex).toBe(0);
    fireEvent.click(askButton());
    await waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledOnce());
    expect(vi.mocked(agentIpc.runAgent).mock.calls[0][1].message).toContain('make it monthly');
  });

  it('carries the AI light only while the rewrite is written', async () => {
    open();
    expect(screen.queryByTestId('ask-ai-working')).toBeNull();
    fireEvent.change(field(), { target: { value: 'make it monthly' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    const working = await screen.findByTestId('ask-ai-working');
    expect(working.textContent).toBe('Rewriting the passage…');
    expect(working.classList.contains('cb-ai-shimmer')).toBe(true);
    expect(field().disabled).toBe(true);
    reply(REWRITE);
    await screen.findByTestId('ask-ai-hunks');
    expect(screen.queryByTestId('ask-ai-working')).toBeNull();
    expect(document.querySelector('.cb-ai-shimmer')).toBeNull();
  });

  it('offers the writing actions as Suggestion rows, each sent as its instruction', async () => {
    open();
    const toggle = screen.getByRole('button', { name: 'Writing actions' });
    expect(toggle.tabIndex).toBe(0);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    const presets = screen.getAllByTestId('selection-preset');
    expect(presets.map((p) => p.dataset.slot)).toEqual(presets.map(() => 'suggestion'));
    expect(presets.every((p) => p.tabIndex === 0)).toBe(true);
    expect(screen.getByRole('group', { name: 'Writing actions' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Improve writing' })).toBe(presets[0]);
    const summarize = screen.getByRole('button', { name: 'Summarize' });
    expect(summarize.getAttribute('title')).toBe(
      'Replace the passage with a two-sentence summary of it.',
    );
    fireEvent.click(summarize);
    await waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledOnce());
    expect(vi.mocked(agentIpc.runAgent).mock.calls[0][1].message).toContain(
      'Replace the passage with a two-sentence summary of it.',
    );
  });

  it('decides in a Confirmation: its hunks, its count, and answers Tab can reach', async () => {
    open();
    fireEvent.change(field(), { target: { value: 'make it monthly' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    await waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    reply('The pricing is monthly and the trial is generous.');
    const card = await screen.findByTestId('ask-ai-decision');
    expect(card.dataset.slot).toBe('confirmation');
    expect(screen.getByRole('group', { name: 'Apply the rewrite?' })).toBe(card);
    expect(card.textContent).toContain('2 of 2 changes · click one to toggle it');
    const hunks = within(card).getAllByTestId('ask-ai-hunk');
    expect(hunks.map((h) => h.getAttribute('aria-pressed'))).toEqual(['true', 'true']);
    fireEvent.click(hunks[0]);
    expect(card.textContent).toContain('1 of 2 changes · click one to toggle it');
    const retry = within(card).getByRole('button', { name: 'Retry' });
    const apply = within(card).getByRole('button', { name: 'Apply' });
    expect([retry.tabIndex, apply.tabIndex]).toEqual([0, 0]);
    fireEvent.click(retry);
    expect(field().value).toBe('make it monthly');
  });

  /* React's development double mount (main.tsx's StrictMode) unmounts and
     mounts again: the answer must still land, and a preset run only once. */
  it('lands its answer, and asks a preset once, through a double mount', async () => {
    const { unmount } = render(
      <StrictMode>
        <AskAiPopover
          selection={PASSAGE}
          preset="Make it monthly"
          onReplace={() => ({ kind: 'applied' })}
          onClose={() => undefined}
        />
      </StrictMode>,
    );
    await waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledOnce());
    await waitFor(() => expect(handlers).toHaveLength(1));
    reply(REWRITE);
    expect(await screen.findByTestId('ask-ai-decision')).toBeTruthy();
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledOnce();
    unmount();
  });

  it('adds no document keydown listener: its keys are its own elements’', async () => {
    const listen = vi.spyOn(document, 'addEventListener');
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Writing actions' }));
    fireEvent.change(field(), { target: { value: 'make it monthly' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    await waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalled());
    reply(REWRITE);
    await screen.findByTestId('ask-ai-decision');
    expect(listen.mock.calls.filter(([kind]) => kind === 'keydown')).toEqual([]);
    listen.mockRestore();
  });
});

describe('AskAiPopover selected passage conflicts', () => {
  beforeEach(() => {
    handlers.length = 0;
    vi.mocked(agentIpc.runAgent).mockClear();
    useVaultStore.setState({ vaultPath: '/vault', entries: [] });
  });

  it('keeps the proposed hunks when Apply conflicts and offers reselect', async () => {
    const close = vi.fn();
    render(
      <AskAiPopover
        selection={PASSAGE}
        preset="Make it monthly"
        onReplace={() => ({ kind: 'conflict' })}
        onClose={close}
      />,
    );
    await waitFor(() => expect(agentIpc.runAgent).toHaveBeenCalled());
    reply(REWRITE);
    await screen.findByTestId('ask-ai-hunks');
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/reselect|select.*again/i);
    expect(screen.getByTestId('ask-ai-hunks').textContent).toContain('monthly');
    expect((screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reselect passage' }));
    expect(close).toHaveBeenCalledOnce();
  });

  it('does not launch a stale first Ask', async () => {
    render(
      <AskAiPopover
        selection={PASSAGE}
        isCurrent={() => false}
        onReplace={() => ({ kind: 'conflict' })}
        onClose={() => undefined}
      />,
    );
    const input = screen.getByLabelText(/What should the assistant do/);
    fireEvent.change(input, { target: { value: 'make it monthly' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(agentIpc.runAgent).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/reselect|select.*again/i);
  });
});

it('does not launch from a skill read whose captured passage became stale', async () => {
  handlers.length = 0;
  vi.mocked(agentIpc.runAgent).mockClear();
  useVaultStore.setState({
    vaultPath: '/vault',
    entries: [
      makeEntry({
        path: 'skills/review.md',
        title: 'Review',
        type: 'Skill',
        properties: {},
      }),
    ],
  });
  let resolve!: (text: string) => void;
  const read = vi.spyOn(ipc, 'readNote').mockReturnValue(
    new Promise<string>((done) => {
      resolve = done;
    }),
  );
  let current = true;
  try {
    render(
      <AskAiPopover
        selection={PASSAGE}
        isCurrent={() => current}
        onReplace={() => ({ kind: 'conflict' })}
        onClose={() => undefined}
      />,
    );
    fireEvent.click(screen.getByTestId('ask-ai-skill'));
    expect(read).toHaveBeenCalledWith('/vault', 'skills/review.md');
    current = false;
    await act(async () => {
      resolve('Review this passage.');
    });
    expect(agentIpc.runAgent).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/reselect|select.*again/i);
  } finally {
    read.mockRestore();
  }
});

it('keeps the completed proposal when Retry finds a stale passage', async () => {
  handlers.length = 0;
  vi.mocked(agentIpc.runAgent).mockClear();
  useVaultStore.setState({ vaultPath: '/vault', entries: [] });
  let current = true;
  render(
    <AskAiPopover
      selection={PASSAGE}
      preset="Make it monthly"
      isCurrent={() => current}
      onReplace={() => ({ kind: 'conflict' })}
      onClose={() => undefined}
    />,
  );
  await waitFor(() => expect(agentIpc.runAgent).toHaveBeenCalled());
  reply(REWRITE);
  await screen.findByTestId('ask-ai-hunks');
  current = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(screen.getByTestId('ask-ai-hunks').textContent).toContain('monthly');
  expect(screen.getByRole('alert').textContent).toMatch(/reselect|select.*again/i);
  expect(agentIpc.runAgent).toHaveBeenCalledOnce();
});
