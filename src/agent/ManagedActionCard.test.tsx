// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { ManagedActionCard } from '@/agent/ManagedActionCard';
import { InteractionCard } from '@/agent/InteractionCard';
import type { WaitingCard } from '@/agent/useAgentChat';
import github from '../../shared/actions/github-issues.v1.json';
import actionPolicy from '../../shared/policy/actions.v1.json';
const schema = github.definitions.find(
  (definition) => definition.actionId === 'github.issue.create',
)!.inputSchema;
const body = '<b>Keep as Markdown text</b>\nFull second line';
const payload = {
  version: 1,
  accountLabel: 'GitHub · fixture',
  preview: {
    summary: 'Create issue',
    fields: [
      { label: 'Repository', value: 'fixture/repo' },
      { label: 'Title', value: 'Review' },
      { label: 'Body', value: body },
    ],
    redactedFields: [],
  },
  inputSchema: schema,
  input: JSON.stringify({ repository: 'fixture/repo', title: 'Review', body }),
};
const waiting = (state: Partial<WaitingCard> = {}): WaitingCard => ({
  card: {
    id: 'b'.repeat(32),
    kind: 'managed_action',
    run: 8,
    tool_name: 'mcp__cerebro__prepare_action',
    tool_id: null,
    session_id: 'session',
    summary: 'Create issue',
    input: JSON.stringify(payload),
    asked_at: '2026-10-26T00:00:00.000Z',
  },
  messageId: 'original',
  answering: false,
  stale: null,
  ...state,
});
afterEach(cleanup);
describe('ManagedActionCard', () => {
  it('shows full native preview and selected account as text before approval', () => {
    const { container } = render(<ManagedActionCard interaction={waiting()} onAnswer={vi.fn()} />);
    expect(screen.getByTestId('managed-action-card').textContent).toContain(body);
    expect(screen.getByText('GitHub · fixture')).toBeTruthy();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.queryByRole('button', { name: 'This conversation' })).toBeNull();
  });
  it('sends only Allow once or Deny without creating new access', () => {
    const answer = vi.fn();
    render(<ManagedActionCard interaction={waiting()} onAnswer={answer} />);
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    expect(answer).toHaveBeenLastCalledWith({ kind: 'allow', remember: 'once' });
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(answer).toHaveBeenLastCalledWith({ kind: 'deny' });
  });
  it('edits the compiled draft form and sends the edited input only on explicit Allow', async () => {
    const answer = vi.fn();
    const user = userEvent.setup();
    render(<ManagedActionCard interaction={waiting()} onAnswer={answer} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit draft' }));
    const title = screen.getByTestId('write-draft-field-title');
    await user.clear(title);
    await user.type(title, 'Revised');
    expect(answer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    expect(answer).toHaveBeenLastCalledWith({
      kind: 'allow',
      remember: 'once',
      updatedInput: { repository: 'fixture/repo', title: 'Revised', body },
    });
  });
  it('refuses a malformed preview while still permitting Deny', () => {
    const answer = vi.fn();
    const card = waiting();
    card.card = { ...card.card, input: '{broken' };
    render(<ManagedActionCard interaction={card} onAnswer={answer} />);
    expect(screen.getByText('The action preview is unavailable.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Allow once' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(answer).toHaveBeenLastCalledWith({ kind: 'deny' });
  });
  it('preserves a refused draft and disables controls when original answer is pending or stale', async () => {
    const user = userEvent.setup();
    const interaction = waiting({ refused: 'Title was refused.' });
    const answer = vi.fn();
    const { rerender } = render(<ManagedActionCard interaction={interaction} onAnswer={answer} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit draft' }));
    const title = screen.getByTestId('write-draft-field-title');
    await user.clear(title);
    await user.type(title, 'Kept edit');
    rerender(
      <ManagedActionCard interaction={{ ...interaction, answering: true }} onAnswer={answer} />,
    );
    expect((screen.getByRole('button', { name: 'Allow once' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByTestId('write-draft-field-title') as HTMLInputElement).value).toBe(
      'Kept edit',
    );
    rerender(
      <ManagedActionCard
        interaction={{ ...interaction, stale: 'Original request ended.' }}
        onAnswer={answer}
      />,
    );
    expect((screen.getByRole('button', { name: 'Deny' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Original request ended.')).toBeTruthy();
    expect(answer).not.toHaveBeenCalled();
  });
  it('mounts the effect renderer through the existing interaction registry', () => {
    render(<InteractionCard interaction={waiting()} onAnswer={vi.fn()} />);
    expect(screen.getByTestId('managed-action-card')).toBeTruthy();
  });
  it('keeps exact unsupported numeric text out of the editor and approves only the untouched request', () => {
    const interaction = waiting();
    interaction.card = {
      ...interaction.card,
      input: JSON.stringify({
        ...payload,
        inputSchema:
          '{"type":"object","properties":{"number":{"type":"number"}},"required":["number"]}',
        input: '{"number":9007199254740993}',
      }),
    };
    const answer = vi.fn();
    render(<ManagedActionCard interaction={interaction} onAnswer={answer} />);
    expect(screen.queryByRole('button', { name: 'Edit draft' })).toBeNull();
    expect(
      screen.getByText('This input cannot be edited here without changing its exact values.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    expect(answer).toHaveBeenLastCalledWith({ kind: 'allow', remember: 'once' });
  });
  it('closing and reopening the editor keeps the visible edited draft matched to what Allow sends', async () => {
    const answer = vi.fn();
    const user = userEvent.setup();
    render(<ManagedActionCard interaction={waiting()} onAnswer={answer} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit draft' }));
    await user.clear(screen.getByTestId('write-draft-field-title'));
    await user.type(screen.getByTestId('write-draft-field-title'), 'Kept edit');
    fireEvent.click(screen.getByRole('button', { name: 'Close editor' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit draft' }));
    expect((screen.getByTestId('write-draft-field-title') as HTMLInputElement).value).toBe(
      'Kept edit',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    expect(answer).toHaveBeenLastCalledWith({
      kind: 'allow',
      remember: 'once',
      updatedInput: { repository: 'fixture/repo', title: 'Kept edit', body },
    });
  });
  it('a different native approval card never inherits the previous card edit', async () => {
    const user = userEvent.setup();
    const answer = vi.fn();
    const first = waiting();
    const { rerender } = render(<ManagedActionCard interaction={first} onAnswer={answer} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit draft' }));
    await user.clear(screen.getByTestId('write-draft-field-title'));
    await user.type(screen.getByTestId('write-draft-field-title'), 'Old edit');
    const next = waiting();
    next.card = { ...next.card, id: 'd'.repeat(32) };
    rerender(<ManagedActionCard interaction={next} onAnswer={answer} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit draft' }));
    expect((screen.getByTestId('write-draft-field-title') as HTMLInputElement).value).toBe(
      'Review',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    expect(answer).toHaveBeenLastCalledWith({ kind: 'allow', remember: 'once' });
  });

  it.each(['field', 'count', 'envelope'] as const)(
    'oversize full preview %s is explicitly unavailable without truncation or Allow',
    (kind) => {
      const policy = actionPolicy.historyInspection;
      const preview = { ...payload.preview, fields: [...payload.preview.fields] };
      if (kind === 'field')
        preview.fields = [
          { label: 'Body', value: 'é'.repeat(Math.floor(policy.maxPreviewValueBytes / 2) + 1) },
        ];
      if (kind === 'count')
        preview.fields = Array.from({ length: policy.maxPreviewFields + 1 }, (_, index) => ({
          label: 'Field ' + index,
          value: 'Full value',
        }));
      if (kind === 'envelope')
        preview.fields = Array.from({ length: policy.maxPreviewFields }, (_, index) => ({
          label: 'Field ' + index,
          value: 'é'.repeat(Math.floor(policy.maxPreviewValueBytes / 2)),
        }));
      const interaction = waiting();
      interaction.card = { ...interaction.card, input: JSON.stringify({ ...payload, preview }) };
      const answer = vi.fn();
      render(<ManagedActionCard interaction={interaction} onAnswer={answer} />);
      expect(screen.getByText('The action preview is unavailable.')).toBeTruthy();
      expect(
        (screen.getByRole('button', { name: 'Allow once' }) as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(screen.queryByText(preview.fields[0].value)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
      expect(answer).toHaveBeenLastCalledWith({ kind: 'deny' });
    },
  );
});

// Newly authored numeric text must pass the same conservative editing boundary
// as the original request, before any JavaScript numeric conversion.
it.each(['9007199254740993', '1.0000000000000001', '-0', '1e0', '1e400'])(
  'retains and refuses unsupported authored flat numeric token %s',
  (text) => {
    const card = waiting();
    card.card = {
      ...card.card,
      input: JSON.stringify({
        ...payload,
        inputSchema:
          '{"type":"object","properties":{"number":{"type":"number"}},"required":["number"]}',
        input: '{"number":1}',
      }),
    };
    const answer = vi.fn();
    render(<ManagedActionCard interaction={card} onAnswer={answer} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit draft' }));
    const field = screen.getByTestId('write-draft-field-number');
    fireEvent.change(field, { target: { value: text } });
    expect((screen.getByRole('button', { name: 'Allow once' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((field as HTMLInputElement).value).toBe(text);
    fireEvent.click(screen.getByTestId('write-draft-json-toggle'));
    expect(screen.queryByTestId('write-draft-json')).toBeNull();
    expect((field as HTMLInputElement).value).toBe(text);
    expect(answer).not.toHaveBeenCalled();
  },
);
it.each(['9007199254740993', '1.0000000000000001', '-0'])(
  'keeps unsupported authored JSON token %s through a close attempt',
  (text) => {
    const card = waiting();
    card.card = {
      ...card.card,
      input: JSON.stringify({
        ...payload,
        inputSchema:
          '{"type":"object","properties":{"number":{"type":"number"}},"required":["number"]}',
        input: '{"number":1}',
      }),
    };
    const answer = vi.fn();
    render(<ManagedActionCard interaction={card} onAnswer={answer} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit draft' }));
    fireEvent.click(screen.getByTestId('write-draft-json-toggle'));
    const field = screen.getByTestId('write-draft-json');
    const authored = '{"number":' + text + '}';
    fireEvent.change(field, { target: { value: authored } });
    expect((screen.getByRole('button', { name: 'Allow once' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByTestId('write-draft-json-toggle'));
    expect((screen.getByTestId('write-draft-json') as HTMLTextAreaElement).value).toBe(authored);
    expect((screen.getByRole('button', { name: 'Allow once' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.change(field, { target: { value: '{"number":2}' } });
    fireEvent.click(screen.getByTestId('write-draft-json-toggle'));
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    expect(answer).toHaveBeenCalledExactlyOnceWith({
      kind: 'allow',
      remember: 'once',
      updatedInput: { number: 2 },
    });
  },
);
