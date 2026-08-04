import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const handlers: Array<(event: unknown) => void> = [];
vi.mock('@/agent/agentIpc', () => ({
  runAgent: vi.fn(async () => 1),
  startMcp: vi.fn(async () => ({ url: 'mock', token: 't' })),
  onAgentEvent: vi.fn((handler: (event: unknown) => void) => {
    handlers.push(handler);
    return () => {
      const i = handlers.indexOf(handler);
      if (i >= 0) handlers.splice(i, 1);
    };
  }),
}));

import * as agentIpc from '@/agent/agentIpc';
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

const reply = (text: string) => {
  for (const handler of [...handlers]) handler({ run: 1, kind: 'Result', text });
  for (const handler of [...handlers]) handler({ run: 1, kind: 'Done' });
};

describe('AskAiPopover', () => {
  let onReplace: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    handlers.length = 0;
    vi.mocked(agentIpc.runAgent).mockClear();
    useVaultStore.setState({ vaultPath: '/vault', entries: [] });
    onReplace = vi.fn();
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
      shell: false,
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

  it('strips a code fence the model wrapped the answer in', async () => {
    open();
    await ask();
    reply('```\n' + REWRITE + '\n```');
    await screen.findByTestId('ask-ai-hunks');
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onReplace).toHaveBeenCalledWith(REWRITE);
  });
});
