// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WRITE_COPY, WriteApprovalCard } from '@/agent/WriteApprovalCard';
import type { WaitingCard } from '@/agent/useAgentChat';
import { makeEntry } from '@/test/factories';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * The card an ask-first agent's page write shows (M57.4): the manifest's
 * title, who asks, the target, the draft as a form the person may edit
 * (M57.4b), and Allow or Deny with an optional reason. Never This
 * conversation.
 */

afterEach(cleanup);

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

beforeEach(() => {
  useVaultStore.setState({ entries: [SCOUT] });
});

describe('WriteApprovalCard', () => {
  it('heads with the manifest title, names the agent and the target', () => {
    render(<WriteApprovalCard interaction={waiting()} onAnswer={vi.fn()} />);
    const card = screen.getByTestId('write-approval');
    expect(card.getAttribute('data-tool')).toBe('mcp__cerebro__create_note');
    expect(card.getAttribute('data-target')).toBe('records/risks');
    expect(screen.getByTestId('write-approval-title').textContent).toBe('Create a note');
    expect(screen.getByTestId('write-approval-byline').textContent).toBe(
      'Release scout asks before writing',
    );
    expect(screen.getByTestId('write-approval-target').textContent).toBe('records/risks');
  });

  it('falls back to the manifest for an older card with no title', () => {
    render(<WriteApprovalCard interaction={waiting({ title: undefined })} onAnswer={vi.fn()} />);
    expect(screen.getByTestId('write-approval-title').textContent).toBe('Create a note');
  });

  it('offers Allow and Deny, never This conversation', () => {
    render(<WriteApprovalCard interaction={waiting()} onAnswer={vi.fn()} />);
    const card = screen.getByTestId('write-approval');
    expect(card.textContent).not.toContain('This conversation');
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      WRITE_COPY.allow,
      WRITE_COPY.deny,
    ]);
  });

  it('allows once, and denies with the reason', () => {
    const onAnswer = vi.fn();
    render(<WriteApprovalCard interaction={waiting()} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByTestId('write-approval-allow'));
    expect(onAnswer).toHaveBeenLastCalledWith({ kind: 'allow', remember: 'once' });
    fireEvent.change(screen.getByTestId('write-approval-reason'), {
      target: { value: '  not yet  ' },
    });
    fireEvent.click(screen.getByTestId('write-approval-deny'));
    expect(onAnswer).toHaveBeenLastCalledWith({ kind: 'deny', message: 'not yet' });
  });

  it('denies with no reason when none is given', () => {
    const onAnswer = vi.fn();
    render(<WriteApprovalCard interaction={waiting()} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByTestId('write-approval-deny'));
    expect(onAnswer).toHaveBeenLastCalledWith({ kind: 'deny' });
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

  it('keeps the card and the edits when Rust refuses the edit', () => {
    const onAnswer = vi.fn();
    const { rerender } = render(<WriteApprovalCard interaction={waiting()} onAnswer={onAnswer} />);
    fireEvent.change(screen.getByTestId('write-draft-field-folder'), {
      target: { value: 'notes' },
    });
    fireEvent.click(screen.getByTestId('write-approval-allow'));
    rerender(
      <WriteApprovalCard interaction={waiting({}, { answering: true })} onAnswer={onAnswer} />,
    );
    const said = 'This run is scoped to records/risks and cannot write to notes.';
    rerender(
      <WriteApprovalCard interaction={waiting({}, { refused: said })} onAnswer={onAnswer} />,
    );
    expect(screen.getByTestId('write-approval-refused').textContent).toBe(said);
    expect((screen.getByTestId('write-draft-field-folder') as HTMLInputElement).value).toBe(
      'notes',
    );
    expect((screen.getByTestId('write-approval-allow') as HTMLButtonElement).disabled).toBe(false);
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
    expect(screen.getByTestId('write-approval-draft').tagName).toBe('PRE');
    expect(screen.queryByTestId('write-draft-form')).toBeNull();
  });

  it('disables its answers while one is on its way, or once it is stale', () => {
    render(<WriteApprovalCard interaction={waiting({}, { answering: true })} onAnswer={vi.fn()} />);
    expect((screen.getByTestId('write-approval-allow') as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    render(
      <WriteApprovalCard
        interaction={waiting({}, { stale: 'No longer waiting.' })}
        onAnswer={vi.fn()}
      />,
    );
    expect(screen.getByTestId('interaction-stale').textContent).toBe('No longer waiting.');
    expect((screen.getByTestId('write-approval-deny') as HTMLButtonElement).disabled).toBe(true);
  });
});
