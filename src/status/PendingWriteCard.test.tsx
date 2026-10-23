// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEntry } from '@/engine/testHelpers';
import type { PendingDecision, PendingWrite } from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { PENDING_COPY, PendingWriteCard } from './PendingWriteCard';

/**
 * One page write an ask-first agent queued for Review (M57.4c): named by
 * its manifest title, its draft editable, and every typed answer read where
 * it lands. It is a Confirmation (M91.14): one group named by its title,
 * whose state says what its answers can do.
 */

const decide = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ipc', async (original) => ({
  ...(await original<typeof import('@/lib/ipc')>()),
  decidePendingWrite: decide,
}));

const ID = 'a'.repeat(32);
const WRITE: PendingWrite = {
  pending_id: ID,
  run_id: 'run-1',
  actor: 'process:release-scout',
  tool: 'create_note',
  target: 'records/risks/vendor-delay.md',
  target_hash: null,
  input: { folder: 'records/risks', slug: 'vendor-delay', body: '# Vendor delay\n' },
  queued_at: new Date().toISOString(),
  state: 'pending',
};

const toasts = () => useUiStore.getState().toasts.map((t) => t.message);
const card = (write: PendingWrite = WRITE) =>
  render(<PendingWriteCard write={write} vaultPath="/vault" />);

beforeEach(() => {
  decide.mockReset();
  useUiStore.setState({ toasts: [] });
  useVaultStore.setState({ vaultPath: '/vault', entries: [] });
});
afterEach(cleanup);

describe('PendingWriteCard (M57.4c)', () => {
  it('heads with the manifest title, and says who asked and where', () => {
    card();
    const shown = screen.getByTestId('pending-write-card');
    expect(shown.getAttribute('data-tool')).toBe('create_note');
    expect(shown.getAttribute('data-pending-id')).toBe(ID);
    expect(screen.getByTestId('pending-write-title').textContent).toBe('Create a note');
    expect(screen.getByTestId('pending-write-target').textContent).toBe(WRITE.target);
    expect(screen.getByTestId('pending-write-when').textContent).toBe('Queued just now by');
    expect(screen.getByTestId('card-author')).not.toBeNull();
    expect(screen.queryByTestId('pending-write-changed')).toBeNull();
  });

  it('says the page changed since it was queued, only when both hashes say so', () => {
    const page = makeEntry({ path: 'records/risks/r-1.md', title: 'R1', hash: 'b'.repeat(64) });
    useVaultStore.setState({ entries: [page] });
    const write = { ...WRITE, tool: 'append_to_note', target: page.path };
    card({ ...write, target_hash: 'c'.repeat(64) });
    expect(screen.getByTestId('pending-write-changed').textContent).toBe(PENDING_COPY.changed);
    // The target opens its page.
    expect(screen.getByTestId('pending-write-target').tagName).toBe('BUTTON');
    cleanup();
    card({ ...write, target_hash: 'b'.repeat(64) });
    expect(screen.queryByTestId('pending-write-changed')).toBeNull();
    cleanup();
    card({ ...write, target_hash: null });
    expect(screen.queryByTestId('pending-write-changed')).toBeNull();
  });

  it('needs a reason to reject, and sends it', async () => {
    decide.mockResolvedValue({ outcome: 'rejected' } satisfies PendingDecision);
    card();
    expect(screen.queryByTestId('pending-write-reason')).toBeNull();
    fireEvent.click(screen.getByTestId('pending-write-reject'));
    const send = screen.getByTestId('pending-write-send') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('pending-write-reason'), { target: { value: '  ' } });
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('pending-write-reason'), {
      target: { value: 'not yet' },
    });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(toasts()).toEqual(['Rejected']));
    expect(decide).toHaveBeenCalledWith('/vault', ID, false, null, 'not yet');
  });

  it('sends the edit only when there is one', async () => {
    decide.mockResolvedValue({ outcome: 'applied', path: WRITE.target });
    card();
    fireEvent.click(screen.getByTestId('pending-write-allow'));
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    expect(decide).toHaveBeenLastCalledWith('/vault', ID, true, null, null);
    cleanup();
    card();
    fireEvent.change(screen.getByTestId('write-draft-field-body'), {
      target: { value: '# Vendor delay risk\n' },
    });
    fireEvent.click(screen.getByTestId('pending-write-allow'));
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(2));
    expect(decide).toHaveBeenLastCalledWith(
      '/vault',
      ID,
      true,
      { ...WRITE.input, body: '# Vendor delay risk\n' },
      null,
    );
  });

  it('holds Allow while an edit the form cannot send waits', () => {
    card();
    const allow = screen.getByTestId('pending-write-allow') as HTMLButtonElement;
    expect(allow.disabled).toBe(false);
    // A draft that is no JSON object is an edit the form cannot send.
    fireEvent.click(screen.getByTestId('write-draft-json-toggle'));
    fireEvent.change(screen.getByTestId('write-draft-json'), { target: { value: '["no"]' } });
    expect(allow.disabled).toBe(true);
    // Reject never waits on the edit.
    expect((screen.getByTestId('pending-write-reject') as HTMLButtonElement).disabled).toBe(false);
  });

  it.each([
    [{ outcome: 'applied', path: WRITE.target }, `Applied — ${WRITE.target}`],
    [
      { outcome: 'refused', reason: 'stale_content: it changed.' },
      'Allowed, but Cerebro refused it: stale_content: it changed. The agent will hear this.',
    ],
    [{ outcome: 'rejected' }, 'Rejected'],
    [{ outcome: 'no_longer_waiting', state: 'applied' }, 'Already decided'],
  ] satisfies [PendingDecision, string][])('reads %o and says so', async (decision, words) => {
    decide.mockResolvedValue(decision);
    card();
    fireEvent.click(screen.getByTestId('pending-write-allow'));
    await waitFor(() => expect(toasts()).toEqual([words]));
  });

  it('keeps the card and the edits when Cerebro refuses the edit', async () => {
    decide.mockResolvedValue({
      outcome: 'edit_refused',
      reason: 'This run is scoped to records/risks and cannot write to notes.',
    });
    card();
    const body = screen.getByTestId('write-draft-field-body') as HTMLTextAreaElement;
    fireEvent.change(body, { target: { value: '# Moved\n' } });
    fireEvent.click(screen.getByTestId('pending-write-allow'));
    await waitFor(() =>
      expect(screen.getByTestId('pending-write-refused').textContent).toContain('scoped'),
    );
    expect(toasts()).toEqual([]);
    expect(body.value).toBe('# Moved\n');
  });

  it("toasts a call that never reached the backend as Couldn't decide", async () => {
    decide.mockRejectedValue(new Error('runtime db gone'));
    card();
    fireEvent.click(screen.getByTestId('pending-write-allow'));
    await waitFor(() => expect(toasts()).toEqual(["Couldn't decide: runtime db gone"]));
    // Nothing was decided: the card waits for an answer still.
    expect(screen.getByTestId('pending-write-card').dataset.state).toBe('pending');
    expect((screen.getByTestId('pending-write-allow') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('PendingWriteCard as a Confirmation (M91.14)', () => {
  it('is one group named by its title, its who and when beside it', () => {
    card();
    const group = screen.getByRole('group', { name: 'Create a note' });
    expect(group).toBe(screen.getByTestId('pending-write-card'));
    expect(group.dataset.slot).toBe('confirmation');
    expect(group.dataset.state).toBe('pending');
    const meta = group.querySelector('[data-slot="confirmation-meta"]');
    expect(meta?.contains(screen.getByTestId('pending-write-when'))).toBe(true);
    expect(meta?.contains(screen.getByTestId('card-author'))).toBe(true);
  });

  it('offers nothing to press while a decision is on its way', async () => {
    let land: (decision: PendingDecision) => void = () => undefined;
    decide.mockReturnValue(
      new Promise<PendingDecision>((resolve) => {
        land = resolve;
      }),
    );
    card();
    fireEvent.click(screen.getByTestId('pending-write-allow'));
    const shown = screen.getByTestId('pending-write-card');
    await waitFor(() => expect(shown.dataset.state).toBe('answering'));
    expect(shown.getAttribute('aria-busy')).toBe('true');
    expect((screen.getByTestId('pending-write-allow') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('pending-write-reject') as HTMLButtonElement).disabled).toBe(true);
    land({ outcome: 'rejected' });
    await waitFor(() => expect(shown.dataset.state).toBe('answered'));
  });

  it('says how it was answered in place of the answers until the queue reads again', async () => {
    decide.mockResolvedValue({ outcome: 'applied', path: WRITE.target });
    card();
    fireEvent.click(screen.getByTestId('pending-write-allow'));
    const outcome = await screen.findByRole('status');
    expect(outcome.textContent).toBe(`Applied — ${WRITE.target}`);
    expect(screen.getByTestId('pending-write-card').dataset.state).toBe('answered');
    // A second press cannot decide a write that no longer waits.
    expect(screen.queryByTestId('pending-write-allow')).toBeNull();
    expect(screen.queryByTestId('pending-write-reject')).toBeNull();
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('waits still under a refused edit, its answers live', async () => {
    decide.mockResolvedValue({ outcome: 'edit_refused', reason: 'Not in scope.' });
    card();
    fireEvent.change(screen.getByTestId('write-draft-field-body'), {
      target: { value: '# Moved\n' },
    });
    fireEvent.click(screen.getByTestId('pending-write-allow'));
    await waitFor(() =>
      expect(screen.getByTestId('pending-write-card').dataset.state).toBe('refused'),
    );
    expect(screen.getByTestId('pending-write-refused').getAttribute('role')).toBe('alert');
    expect((screen.getByTestId('pending-write-allow') as HTMLButtonElement).disabled).toBe(false);
    // An edit after the refusal clears it.
    fireEvent.change(screen.getByTestId('write-draft-field-body'), {
      target: { value: '# Moved again\n' },
    });
    expect(screen.queryByTestId('pending-write-refused')).toBeNull();
    expect(screen.getByTestId('pending-write-card').dataset.state).toBe('pending');
  });

  it('asks for the reason only once Reject is pressed, in place of Reject', () => {
    card();
    fireEvent.click(screen.getByTestId('pending-write-reject'));
    expect(screen.queryByTestId('pending-write-reject')).toBeNull();
    const reason = screen.getByTestId('pending-write-reason');
    expect(reason.getAttribute('placeholder')).toBe(PENDING_COPY.reason);
    expect(document.activeElement).toBe(reason);
  });
});
