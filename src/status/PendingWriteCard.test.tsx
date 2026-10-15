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
 * it lands.
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
  });
});
