// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WRITE_COPY, WriteApprovalCard } from '@/agent/WriteApprovalCard';
import type { WaitingCard } from '@/agent/useAgentChat';
import { makeEntry } from '@/test/factories';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * The card an ask-first agent's page write shows (M57.4), drawn as a
 * Confirmation (M91.12b): the manifest's title, who asks, the target, the
 * draft as a form the person may edit (M57.4b), and Allow or Deny with an
 * optional reason, by pointer and by keyboard. Never This conversation.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SCOUT = makeEntry({
  path: 'records/agents/release-scout.md',
  folder: 'records/agents',
  title: 'Release scout',
  type: 'Agent',
  properties: { slug: 'release-scout' } as never,
});

const DRAFT = { folder: 'records/risks', slug: 'vendor-delay', body: '# Vendor delay\n' };

const waiting = (over: Partial<WaitingCard['card']> = {}, state: Partial<WaitingCard> = {}) =>
  ({
    card: {
      id: 'c'.repeat(32),
      kind: 'write',
      tool_name: 'mcp__cerebro__create_note',
      tool_id: 't-1',
      session_id: 's-1',
      summary: 'Create a note · records/risks',
      family: 'confirmable',
      subject: '{}',
      title: 'Create a note',
      target: 'records/risks',
      actor: 'process:release-scout',
      input: JSON.stringify(DRAFT, null, 2),
      asked_at: '2026-10-14T12:00:00.000Z',
      ...over,
    },
    messageId: 'm-2',
    answering: false,
    stale: null,
    ...state,
  }) satisfies WaitingCard;

/** The keydown listeners added to window and document while `run` runs. */
function keydownsDuring(run: () => void): number {
  const onWindow = vi.spyOn(window, 'addEventListener');
  const onDocument = vi.spyOn(document, 'addEventListener');
  try {
    run();
    return [...onWindow.mock.calls, ...onDocument.mock.calls].filter(([type]) => type === 'keydown')
      .length;
  } finally {
    onWindow.mockRestore();
    onDocument.mockRestore();
  }
}

beforeEach(() => {
  useVaultStore.setState({ entries: [SCOUT] });
});

describe('WriteApprovalCard', () => {
  it('heads with the manifest title, names the agent and the target', () => {
    render(<WriteApprovalCard interaction={waiting()} onAnswer={vi.fn()} />);
    const card = screen.getByTestId('write-approval');
    expect(card.getAttribute('data-tool')).toBe('mcp__cerebro__create_note');
    expect(card.getAttribute('data-target')).toBe('records/risks');
    expect(card.getAttribute('data-state')).toBe('waiting');
    expect(screen.getByTestId('write-approval-title').textContent).toBe('Create a note');
    expect(screen.getByTestId('write-approval-byline').textContent).toBe(
      'Release scout asks before writing',
    );
    expect(screen.getByTestId('write-approval-target').textContent).toBe('records/risks');
  });

  it('is a Confirmation: a group named by its family’s question', () => {
    render(<WriteApprovalCard interaction={waiting()} onAnswer={vi.fn()} />);
    const card = screen.getByRole('group', { name: 'Allow this page write?' });
    expect(card).toBe(screen.getByTestId('write-approval'));
    expect(card.dataset.slot).toBe('confirmation');
    expect(card.querySelector('[data-icon="hand"]')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('is named by its title when its call names no family', () => {
    render(<WriteApprovalCard interaction={waiting({ family: null })} onAnswer={vi.fn()} />);
    expect(screen.getByRole('group', { name: 'Create a note' })).toBe(
      screen.getByTestId('write-approval'),
    );
  });

  it('falls back to the manifest for an older card with no title', () => {
    render(<WriteApprovalCard interaction={waiting({ title: undefined })} onAnswer={vi.fn()} />);
    expect(screen.getByTestId('write-approval-title').textContent).toBe('Create a note');
  });

  it('names the assistant when no agent asks, and leaves out a target it has not', () => {
    render(
      <WriteApprovalCard interaction={waiting({ actor: null, target: null })} onAnswer={vi.fn()} />,
    );
    expect(screen.getByTestId('write-approval-byline').textContent).toBe(
      'The assistant asks before writing',
    );
    expect(screen.queryByTestId('write-approval-target')).toBeNull();
    expect(screen.getByTestId('write-approval').getAttribute('data-target')).toBe('');
  });

  it('offers Allow and Deny, never This conversation', () => {
    render(<WriteApprovalCard interaction={waiting()} onAnswer={vi.fn()} />);
    const card = screen.getByTestId('write-approval');
    expect(card.textContent).not.toContain('This conversation');
    // The answers, not the draft's fields: a choice field is a listbox button.
    const form = screen.getByTestId('write-draft-form');
    expect(
      screen
        .getAllByRole('button')
        .filter((b) => !form.contains(b))
        .map((b) => b.textContent),
    ).toEqual([WRITE_COPY.allow, WRITE_COPY.deny]);
  });

  it('allows once, and denies with the reason', () => {
    const onAnswer = vi.fn();
    render(<WriteApprovalCard interaction={waiting()} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByTestId('write-approval-allow'));
    expect(onAnswer).toHaveBeenLastCalledWith({ kind: 'allow', remember: 'once' });
    const reason = screen.getByRole('textbox', { name: WRITE_COPY.reason });
    expect(reason).toBe(screen.getByTestId('write-approval-reason'));
    fireEvent.change(reason, { target: { value: '  not yet  ' } });
    fireEvent.click(screen.getByTestId('write-approval-deny'));
    expect(onAnswer).toHaveBeenLastCalledWith({ kind: 'deny', message: 'not yet' });
  });

  it('denies with no reason when none is given', () => {
    const onAnswer = vi.fn();
    render(<WriteApprovalCard interaction={waiting()} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByTestId('write-approval-deny'));
    expect(onAnswer).toHaveBeenLastCalledWith({ kind: 'deny' });
  });

  it('answers from the keyboard: the draft’s fields, the reason, then Allow and Deny', async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    render(<WriteApprovalCard interaction={waiting()} onAnswer={onAnswer} />);
    const visited: (string | null)[] = [];
    for (let step = 0; step < 12; step += 1) {
      await user.tab();
      const at = document.activeElement?.getAttribute('data-testid') ?? null;
      visited.push(at);
      if (at === 'write-approval-deny') break;
    }
    expect(visited.slice(-4)).toEqual([
      'write-draft-json-toggle',
      'write-approval-reason',
      'write-approval-allow',
      'write-approval-deny',
    ]);
    expect(visited).toContain('write-draft-field-body');
    await user.tab({ shift: true });
    await user.keyboard('{Enter}');
    expect(onAnswer).toHaveBeenLastCalledWith({ kind: 'allow', remember: 'once' });
  });

  it('adds no window or document keydown listener, drawn, edited and answered', () => {
    const added = keydownsDuring(() => {
      render(<WriteApprovalCard interaction={waiting()} onAnswer={vi.fn()} />);
      fireEvent.change(screen.getByTestId('write-draft-field-body'), {
        target: { value: '# Vendor delay risk\n' },
      });
      const reason = screen.getByTestId('write-approval-reason');
      fireEvent.change(reason, { target: { value: 'Not now' } });
      fireEvent.keyDown(reason, { key: 'Enter' });
      fireEvent.click(screen.getByTestId('write-approval-deny'));
    });
    expect(added).toBe(0);
  });

  it('shows the draft as a form, the agent’s text as text', () => {
    render(
      <WriteApprovalCard
        interaction={waiting({ input: JSON.stringify({ ...DRAFT, body: '<b>Vendor</b> delay' }) })}
        onAnswer={vi.fn()}
      />,
    );
    const body = screen.getByTestId('write-draft-field-body') as HTMLInputElement;
    expect(body.value).toBe('<b>Vendor</b> delay');
    expect(screen.getByTestId('write-approval').querySelector('b')).toBeNull();
  });

  it('allows an edited draft with it as updatedInput', () => {
    const onAnswer = vi.fn();
    render(<WriteApprovalCard interaction={waiting()} onAnswer={onAnswer} />);
    fireEvent.change(screen.getByTestId('write-draft-field-body'), {
      target: { value: '# Vendor delay risk\n' },
    });
    fireEvent.click(screen.getByTestId('write-approval-allow'));
    expect(onAnswer).toHaveBeenLastCalledWith({
      kind: 'allow',
      remember: 'once',
      updatedInput: { ...DRAFT, body: '# Vendor delay risk\n' },
    });
  });

  it('sends no updatedInput when the edit is undone', () => {
    const onAnswer = vi.fn();
    render(<WriteApprovalCard interaction={waiting()} onAnswer={onAnswer} />);
    const body = screen.getByTestId('write-draft-field-body');
    fireEvent.change(body, { target: { value: '# Other\n' } });
    fireEvent.change(body, { target: { value: DRAFT.body } });
    fireEvent.click(screen.getByTestId('write-approval-allow'));
    expect(onAnswer).toHaveBeenLastCalledWith({ kind: 'allow', remember: 'once' });
  });

  it('keeps the card and the edits when Rust refuses the edit, and waits still', () => {
    const onAnswer = vi.fn();
    const { rerender } = render(<WriteApprovalCard interaction={waiting()} onAnswer={onAnswer} />);
    const card = screen.getByTestId('write-approval');
    fireEvent.change(screen.getByTestId('write-draft-field-folder'), {
      target: { value: 'notes' },
    });
    fireEvent.change(screen.getByTestId('write-approval-reason'), {
      target: { value: 'maybe not' },
    });
    fireEvent.click(screen.getByTestId('write-approval-allow'));
    rerender(
      <WriteApprovalCard interaction={waiting({}, { answering: true })} onAnswer={onAnswer} />,
    );
    expect(card.getAttribute('data-state')).toBe('answering');
    expect((screen.getByTestId('write-draft-field-folder') as HTMLInputElement).readOnly).toBe(
      true,
    );
    const said = 'This run is scoped to records/risks and cannot write to notes.';
    rerender(
      <WriteApprovalCard interaction={waiting({}, { refused: said })} onAnswer={onAnswer} />,
    );
    expect(screen.getByTestId('write-approval')).toBe(card);
    expect(card.getAttribute('data-state')).toBe('refused');
    expect(screen.getByRole('alert')).toBe(screen.getByTestId('write-approval-refused'));
    expect(screen.getByTestId('write-approval-refused').textContent).toBe(said);
    expect((screen.getByTestId('write-draft-field-folder') as HTMLInputElement).value).toBe(
      'notes',
    );
    expect((screen.getByTestId('write-draft-field-folder') as HTMLInputElement).readOnly).toBe(
      false,
    );
    expect((screen.getByTestId('write-approval-reason') as HTMLInputElement).value).toBe(
      'maybe not',
    );
    expect((screen.getByTestId('write-approval-allow') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('write-approval-deny') as HTMLButtonElement).disabled).toBe(false);
  });

  it('waits on Allow while the edit is invalid, and lets Deny through', () => {
    const onAnswer = vi.fn();
    render(<WriteApprovalCard interaction={waiting()} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByTestId('write-draft-json-toggle'));
    fireEvent.change(screen.getByTestId('write-draft-json'), { target: { value: '[]' } });
    const allow = screen.getByTestId('write-approval-allow') as HTMLButtonElement;
    expect(allow.disabled).toBe(true);
    fireEvent.click(allow);
    expect(onAnswer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('write-approval-deny'));
    expect(onAnswer).toHaveBeenLastCalledWith({ kind: 'deny' });
  });

  it('shows a draft that is no JSON object read-only', () => {
    render(<WriteApprovalCard interaction={waiting({ input: '{ "cut": ' })} onAnswer={vi.fn()} />);
    const draft = screen.getByTestId('write-approval-draft');
    expect(draft.tagName).toBe('PRE');
    expect(draft.textContent).toBe('{ "cut": ');
    expect((draft.closest('details') as HTMLDetailsElement).open).toBe(false);
    expect(screen.queryByTestId('write-draft-form')).toBeNull();
  });

  it('disables its answers while one is on its way, or once it is stale', () => {
    render(<WriteApprovalCard interaction={waiting({}, { answering: true })} onAnswer={vi.fn()} />);
    expect(screen.getByTestId('write-approval').getAttribute('aria-busy')).toBe('true');
    expect((screen.getByTestId('write-approval-allow') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('write-approval-reason') as HTMLInputElement).disabled).toBe(true);
    cleanup();
    const onAnswer = vi.fn();
    render(
      <WriteApprovalCard
        interaction={waiting({}, { stale: 'No longer waiting.' })}
        onAnswer={onAnswer}
      />,
    );
    expect(screen.getByTestId('write-approval').getAttribute('data-state')).toBe('stale');
    expect(screen.getByTestId('interaction-stale').textContent).toBe('No longer waiting.');
    expect((screen.getByTestId('write-approval-deny') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('write-approval-allow') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('write-approval-allow'));
    expect(onAnswer).not.toHaveBeenCalled();
  });
});
