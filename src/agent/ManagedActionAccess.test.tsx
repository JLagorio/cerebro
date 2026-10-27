import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunActionAccessView, SetRunActionAccessResult } from '@/lib/generated/actions';
import { ManagedActionAccess } from './ManagedActionAccess';
import {
  createRunActionAccessSession,
  type RunActionAccessApi,
} from './managedActionAccessSession';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const view: RunActionAccessView = {
  runId: 'original-run',
  accessRevision: 'access-a',
  accessRequestId: 'request-a',
  grants: [],
  accounts: [
    {
      connectionId: 'connection-a',
      accountId: 'alice',
      label: 'Alice on GitHub',
      accountRevision: 2,
      revocationGeneration: 0,
    },
  ],
  definitions: [
    {
      actionId: 'github.issue.read',
      definitionDigest: 'read-v1',
      inputSchemaDigest: 'input-v1',
      outputSchemaDigest: 'output-v1',
      inputSchema: '{"type":"object"}',
      outputSchema: '{"type":"object"}',
      adapterRevision: 'adapter-v1',
      effectClass: 'read',
      requiredCapabilities: ['github.issue.read'],
      retry: 'never',
      cancel: false,
      reconcile: false,
    },
  ],
};
function setup() {
  const api = {
    read: vi.fn<RunActionAccessApi['read']>().mockResolvedValue(view),
    set: vi
      .fn<RunActionAccessApi['set']>()
      .mockResolvedValue({
        state: 'changed',
        view: { ...view, accessRequestId: null },
        sourceCurrent: true,
        requestClosed: true,
      }),
  };
  const session = createRunActionAccessSession(41, 'request-a', api);
  const close = vi.fn();
  return { api, session, close, props: { open: true, onClose: close, session } };
}
describe('This run action access sheet', () => {
  it('starts with no account grants and sends a deliberate empty Done only on the person’s click', async () => {
    const { api, props } = setup();
    render(<ManagedActionAccess {...props} />);
    expect(await screen.findByRole('dialog', { name: 'Access for this run' })).toBeTruthy();
    await screen.findByText('No actions selected.');
    expect(api.set).not.toHaveBeenCalled();
    expect(screen.getByText(/external changes still need your approval/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() =>
      expect(api.set).toHaveBeenCalledExactlyOnceWith(41, {
        expectedAccessRevision: 'access-a',
        completeRequestId: 'request-a',
        selections: [],
      }),
    );
    expect(await screen.findByText('Access saved for this run.')).toBeTruthy();
  });
  it('adds only explicit account/action choices and preserves exact input text', async () => {
    const { api, props } = setup();
    render(<ManagedActionAccess {...props} />);
    await screen.findByText('No actions selected.');
    expect(screen.getByRole('button', { name: 'Add action' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByLabelText('Account'));
    fireEvent.click(screen.getByRole('option', { name: 'Alice on GitHub' }));
    fireEvent.click(screen.getByLabelText('Action'));
    fireEvent.click(screen.getByRole('option', { name: 'github.issue.read' }));
    fireEvent.click(screen.getByLabelText('Allowed inputs'));
    fireEvent.click(screen.getByRole('option', { name: 'Only these exact inputs' }));
    const input = '{"number":9007199254740993.00000001}';
    fireEvent.change(screen.getByLabelText('Exact action inputs'), { target: { value: input } });
    fireEvent.click(screen.getByRole('button', { name: 'Add action' }));
    expect(api.set).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(api.set).toHaveBeenCalledTimes(1));
    expect(api.set.mock.calls[0][1].selections).toEqual([
      {
        kind: 'new',
        selection: {
          connectionId: 'connection-a',
          accountId: 'alice',
          accountRevision: 2,
          revocationGeneration: 0,
          actionId: 'github.issue.read',
          definitionDigest: 'read-v1',
          inputScope: { kind: 'exact_canonical_input', input },
        },
      },
    ]);
  });
  it('keeps unavailable distinct from an empty grant list and offers an explicit reload', async () => {
    const { api, props } = setup();
    api.read.mockRejectedValueOnce('unavailable');
    render(<ManagedActionAccess {...props} />);
    expect(await screen.findByTestId('section-unavailable')).toBeTruthy();
    expect(screen.queryByText('No actions selected.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Done' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Reload current access' }));
    expect(await screen.findByText('No actions selected.')).toBeTruthy();
  });
  it('keeps a pending write owned across closing and reopening without a second submission', async () => {
    const { api, props, session } = setup();
    let finish!: (result: SetRunActionAccessResult) => void;
    api.set.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const first = render(<ManagedActionAccess {...props} />);
    await screen.findByText('No actions selected.');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(session.getSnapshot().phase).toBe('saving'));
    first.unmount();
    render(<ManagedActionAccess {...props} />);
    expect(screen.getByRole('button', { name: 'Saving…' }).hasAttribute('disabled')).toBe(true);
    expect(api.read).toHaveBeenCalledTimes(1);
    expect(api.set).toHaveBeenCalledTimes(1);
    finish({
      state: 'changed',
      view: { ...view, accessRequestId: null },
      sourceCurrent: false,
      requestClosed: false,
    });
    expect(await screen.findByText(/saved for the original run/i)).toBeTruthy();
    expect(screen.getByText(/no longer current/i)).toBeTruthy();
  });
});
