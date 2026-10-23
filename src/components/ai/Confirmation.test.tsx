// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONFIRMATION_WORDS,
  Confirmation,
  ConfirmationSubject,
  type ConfirmationState,
} from './Confirmation';

/**
 * Confirmation (M91.9): one anatomy for every card that asks — the
 * assistant's permission and write cards, Review's queued writes and
 * proposals — each keeping its own words and test hooks. The state says what
 * its answers can do.
 */

afterEach(cleanup);

/** The permission card's shape (agent/PermissionCard.tsx). */
function Permission({
  state = 'pending',
  onOnce = () => undefined,
  onConversation = () => undefined,
  onDeny = () => undefined,
  notice,
}: {
  state?: ConfirmationState;
  onOnce?: () => void;
  onConversation?: () => void;
  onDeny?: (reason: string | null) => void;
  notice?: string;
}) {
  return (
    <Confirmation
      data-testid="permission-card"
      data-family="shell"
      data-tool="Bash"
      state={state}
      icon="shield-question-mark"
      title="Run this command?"
      summary="The assistant is waiting for your answer."
      notice={notice}
      testIds={{ notice: 'interaction-stale' }}
      approve={[
        { label: 'Allow once', testId: 'permission-allow-once', onClick: onOnce },
        {
          label: 'This conversation',
          testId: 'permission-allow-conversation',
          onClick: onConversation,
        },
      ]}
      deny={{ testId: 'permission-deny', onDeny }}
    >
      <ConfirmationSubject data-testid="permission-subject">
        {'git push origin main <b>now</b>'}
      </ConfirmationSubject>
    </Confirmation>
  );
}

const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('button')];

describe('Confirmation', () => {
  it('is a group named by what it asks, keeping the card’s own hooks', () => {
    render(<Permission />);
    const card = screen.getByRole('group', { name: 'Run this command?' });
    expect(card).toBe(screen.getByTestId('permission-card'));
    expect(card.dataset.family).toBe('shell');
    expect(card.dataset.tool).toBe('Bash');
    expect(card.dataset.state).toBe('pending');
    expect(card.dataset.slot).toBe('confirmation');
    expect(
      card.querySelector('[data-slot="item-media"] [data-icon]')?.getAttribute('aria-hidden'),
    ).toBe('true');
    expect(screen.getByText('The assistant is waiting for your answer.')).toBeTruthy();
  });

  it('shows what the agent asked to run as text, verbatim, never markup', () => {
    render(<Permission />);
    const subject = screen.getByTestId('permission-subject');
    expect(subject.tagName).toBe('PRE');
    expect(subject.textContent).toBe('git push origin main <b>now</b>');
    expect(subject.querySelector('b')).toBeNull();
  });

  it('answers through the caller: the first yes primary, the rest secondary, then Deny', () => {
    const onOnce = vi.fn();
    const onConversation = vi.fn();
    const onDeny = vi.fn();
    render(<Permission onOnce={onOnce} onConversation={onConversation} onDeny={onDeny} />);
    expect(buttons().map((button) => button.textContent)).toEqual([
      'Allow once',
      'This conversation',
      CONFIRMATION_WORDS.deny,
    ]);
    expect(screen.getByTestId('permission-allow-once').className).toContain('cb-btn-primary');
    expect(screen.getByTestId('permission-allow-conversation').className).toContain(
      'cb-btn-secondary',
    );
    fireEvent.click(screen.getByTestId('permission-allow-once'));
    fireEvent.click(screen.getByTestId('permission-allow-conversation'));
    fireEvent.click(screen.getByTestId('permission-deny'));
    expect(onOnce).toHaveBeenCalledOnce();
    expect(onConversation).toHaveBeenCalledOnce();
    expect(onDeny).toHaveBeenCalledWith(null);
  });

  it('keeps every answer in the Tab order, as WebKit needs it said', () => {
    render(<Permission />);
    for (const button of buttons()) expect(button.getAttribute('tabindex')).toBe('0');
  });

  it('offers nothing to press while an answer is on its way', () => {
    render(<Permission state="answering" />);
    const card = screen.getByTestId('permission-card');
    expect(card.dataset.state).toBe('answering');
    expect(card.getAttribute('aria-busy')).toBe('true');
    expect(buttons().every((button) => button.disabled)).toBe(true);
  });

  it('says why it can no longer be answered, and offers nothing', () => {
    render(<Permission state="stale" notice="This call is no longer waiting." />);
    expect(screen.getByTestId('interaction-stale').textContent).toBe(
      'This call is no longer waiting.',
    );
    expect(buttons().every((button) => button.disabled)).toBe(true);
    expect(screen.getByTestId('permission-card').getAttribute('aria-busy')).toBeNull();
  });

  it('shows how it was answered in place of the answers', () => {
    render(
      <Confirmation
        state="answered"
        title="Run this command?"
        outcome="Allowed once"
        testIds={{ outcome: 'permission-outcome' }}
        approve={[{ label: 'Allow once', onClick: () => undefined }]}
        deny={{ onDeny: () => undefined }}
      />,
    );
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByRole('status').textContent).toBe('Allowed once');
    expect(screen.getByTestId('permission-outcome')).toBe(screen.getByRole('status'));
  });

  it('draws no answers of its own when its body answers for itself', () => {
    render(
      <Confirmation state="pending" title="A question for you">
        <button type="button">Send answers</button>
      </Confirmation>,
    );
    const card = screen.getByRole('group', { name: 'A question for you' });
    expect(card.querySelector('[data-slot="confirmation-answers"]')).toBeNull();
    expect(buttons().map((button) => button.textContent)).toEqual(['Send answers']);
  });

  it('takes a caller’s name, and its older state words where its specs read them', () => {
    render(
      <Confirmation
        aria-label="Change this file?"
        data-state="waiting"
        state="pending"
        title="Update a page"
        approve={[{ label: 'Allow', onClick: () => undefined }]}
      />,
    );
    const card = screen.getByRole('group', { name: 'Change this file?' });
    expect(card.getAttribute('aria-labelledby')).toBeNull();
    expect(card.dataset.state).toBe('waiting');
  });
});

describe('a write the person may refuse with a reason', () => {
  function Write({
    state = 'pending',
    onDeny = () => undefined,
    refusal,
  }: {
    state?: ConfirmationState;
    onDeny?: (reason: string | null) => void;
    refusal?: string;
  }) {
    return (
      <Confirmation
        data-testid="write-approval"
        state={state}
        icon="hand"
        title="Update a page"
        summary="Scout asks before writing"
        refusal={refusal}
        testIds={{
          title: 'write-approval-title',
          summary: 'write-approval-byline',
          refusal: 'write-approval-refused',
        }}
        approve={[{ label: 'Allow', testId: 'write-approval-allow', onClick: () => undefined }]}
        deny={{
          testId: 'write-approval-deny',
          onDeny,
          reason: { label: 'Why not? (optional)', testId: 'write-approval-reason' },
        }}
      >
        <span data-testid="write-approval-target">notes/plan.md</span>
      </Confirmation>
    );
  }

  it('keeps its title, byline and target hooks', () => {
    render(<Write />);
    expect(screen.getByTestId('write-approval-title').textContent).toBe('Update a page');
    expect(screen.getByTestId('write-approval-byline').textContent).toBe(
      'Scout asks before writing',
    );
    expect(screen.getByTestId('write-approval-target').textContent).toBe('notes/plan.md');
  });

  it('sends the reason, trimmed, with Deny, and none when the field is empty', () => {
    const onDeny = vi.fn();
    render(<Write onDeny={onDeny} />);
    fireEvent.click(screen.getByTestId('write-approval-deny'));
    expect(onDeny).toHaveBeenLastCalledWith(null);
    const field = screen.getByRole('textbox', { name: 'Why not? (optional)' });
    expect(field).toBe(screen.getByTestId('write-approval-reason'));
    expect(field.getAttribute('maxlength')).toBe('2000');
    fireEvent.change(field, { target: { value: '  Not that page.  ' } });
    fireEvent.click(screen.getByTestId('write-approval-deny'));
    expect(onDeny).toHaveBeenLastCalledWith('Not that page.');
  });

  it('still waits under a refusal, said at once', () => {
    render(<Write state="refused" refusal="That field is not on the page's type." />);
    const refused = screen.getByRole('alert');
    expect(refused).toBe(screen.getByTestId('write-approval-refused'));
    expect(screen.getByTestId('write-approval').dataset.state).toBe('refused');
    expect(buttons().some((button) => button.disabled)).toBe(false);
    expect((screen.getByTestId('write-approval-reason') as HTMLInputElement).disabled).toBe(false);
  });

  it('closes its field too once it can no longer be answered', () => {
    render(<Write state="stale" />);
    expect((screen.getByTestId('write-approval-reason') as HTMLInputElement).disabled).toBe(true);
  });
});

describe('Review’s cards', () => {
  it('a proposal: Reject waits for a reason, and a yes can wait on its own', () => {
    const onDeny = vi.fn();
    const askFresh = vi.fn();
    render(
      <Confirmation
        data-testid="review-card"
        variant="outline"
        state="pending"
        title="Update Pricing"
        meta={<span data-testid="card-author">Scout</span>}
        notice="Pricing changed since this was proposed."
        approve={[
          {
            label: 'Ask for a fresh proposal',
            icon: 'sparkles',
            testId: 'ask-fresh',
            onClick: askFresh,
          },
          {
            label: 'Approve',
            testId: 'approve',
            variant: 'secondary',
            disabled: true,
            onClick: () => undefined,
          },
        ]}
        deny={{
          label: 'Reject',
          testId: 'reject',
          onDeny,
          reason: { label: 'Why not?', required: true, testId: 'reject-reason' },
        }}
      />,
    );
    const card = screen.getByTestId('review-card');
    expect(card.classList.contains('cb-ai-confirmation-ask')).toBe(false);
    expect(card.querySelector('[data-slot="confirmation-meta"]')?.textContent).toBe('Scout');
    expect((screen.getByTestId('approve') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('ask-fresh').className).toContain('cb-btn-primary');
    expect(screen.getByTestId('ask-fresh').querySelector('[data-icon="sparkles"]')).not.toBeNull();
    const reject = screen.getByTestId('reject') as HTMLButtonElement;
    expect(reject.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('reject-reason'), { target: { value: '   ' } });
    expect(reject.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('reject-reason'), { target: { value: 'Out of date' } });
    expect(reject.disabled).toBe(false);
    fireEvent.click(reject);
    expect(onDeny).toHaveBeenCalledWith('Out of date');
    fireEvent.click(screen.getByTestId('ask-fresh'));
    expect(askFresh).toHaveBeenCalledOnce();
  });

  it('a queued write: Reject asks for the reason, and Send waits for it', () => {
    const onDeny = vi.fn();
    render(
      <Confirmation
        data-testid="pending-write-card"
        state="pending"
        title="Update a page"
        approve={[{ label: 'Allow', testId: 'pending-write-allow', onClick: () => undefined }]}
        deny={{
          label: 'Reject',
          testId: 'pending-write-reject',
          onDeny,
          reason: {
            label: 'Why not? The agent will read this.',
            required: true,
            when: 'on_deny',
            testId: 'pending-write-reason',
            sendTestId: 'pending-write-send',
          },
        }}
      />,
    );
    expect(screen.queryByTestId('pending-write-reason')).toBeNull();
    fireEvent.click(screen.getByTestId('pending-write-reject'));
    expect(onDeny).not.toHaveBeenCalled();
    expect(screen.queryByTestId('pending-write-reject')).toBeNull();
    const field = screen.getByTestId('pending-write-reason');
    expect(document.activeElement).toBe(field);
    const send = screen.getByTestId('pending-write-send') as HTMLButtonElement;
    expect(send.textContent).toBe(CONFIRMATION_WORDS.send);
    expect(send.disabled).toBe(true);
    fireEvent.change(field, { target: { value: 'Wrong project' } });
    fireEvent.click(send);
    expect(onDeny).toHaveBeenCalledWith('Wrong project');
  });
});
