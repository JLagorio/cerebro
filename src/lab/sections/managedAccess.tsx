import { useState } from 'react';
import { ManagedActionAccess } from '@/agent/ManagedActionAccess';
import { ManagedAccessCard } from '@/agent/ManagedAccessCard';
import { createRunActionAccessSession } from '@/agent/managedActionAccessSession';
import { Button } from '@/components/ui/Button';
import type { RunActionAccessView } from '@/lib/generated/actions';
import { faulted } from '@/lib/mockFaults';
import type { LabSection, LabState } from '../presets';

function view(state: LabState): RunActionAccessView {
  const empty = state === 'empty';
  return {
    runId: 'lab-run',
    accessRevision: 'lab-revision',
    accessRequestId: 'lab-request',
    accounts: empty
      ? []
      : [
          {
            connectionId: 'github',
            accountId: 'lab-reader',
            accountRevision: 1,
            revocationGeneration: 0,
            label: 'Research workspace · lab-reader',
          },
        ],
    definitions: empty
      ? []
      : [
          {
            actionId: 'github.issue.read',
            adapterRevision: '1',
            definitionDigest: 'd'.repeat(64),
            effectClass: 'read',
            cancel: true,
            reconcile: false,
            retry: 'never',
            requiredCapabilities: [],
            inputSchema:
              '{"type":"object","properties":{"number":{"type":"integer"}},"additionalProperties":false}',
            inputSchemaDigest: 'e'.repeat(64),
            outputSchema: '{"type":"object"}',
            outputSchemaDigest: 'f'.repeat(64),
          },
        ],
    grants: empty
      ? []
      : [
          {
            grantId: 'lab-grant',
            revision: 1,
            connectionId: 'github',
            accountId: 'lab-reader',
            actionId: 'github.issue.read',
            definitionDigest: 'd'.repeat(64),
            available: state !== 'partial',
            inputScope: { kind: 'exact_canonical_input', inputDigest: 'b'.repeat(64) },
          },
        ],
  };
}
let selected: LabState = 'ready';
function preview(state: LabState) {
  // Display-only replies. The lab cannot call IPC, credentials or providers.
  return createRunActionAccessSession(41, 'lab-request', {
    read: () => faulted('read_managed_action_access', async () => view(state)),
    set: async () => ({
      state: 'changed',
      view: { ...view(state), accessRequestId: null },
      sourceCurrent: true,
      requestClosed: true,
    }),
  });
}
let session = preview(selected);
const seed = (state: LabState) => () => {
  selected = state;
  session = preview(state);
};
function Stage() {
  const [open, setOpen] = useState(true);
  if (selected === 'not-recorded')
    return (
      <ManagedAccessCard
        interaction={{
          card: {
            kind: 'managed_access',
            id: 'lab-missing',
            run: null,
            session_id: 'lab-session',
            tool_name: 'list_actions',
            tool_id: null,
            summary: 'Choose run access',
            input: '{}',
            asked_at: '2026-10-26T12:00:00Z',
          },
          answering: false,
          stale: null,
          messageId: 'lab-message',
        }}
      />
    );
  return (
    <>
      <Button onClick={() => setOpen(true)}>Review run access</Button>
      <ManagedActionAccess open={open} onClose={() => setOpen(false)} session={session} />
    </>
  );
}
export const section: LabSection = {
  id: 'managed-access',
  title: 'Access for this run',
  surface: 'Assistant › Access for this run',
  render: () => <Stage />,
  states: {
    ready: {
      note: 'One selected exact-input action. The original input is not disclosed or reconstructed.',
      seed: seed('ready'),
      expect: { present: ['[role="dialog"]'], text: 'Exact inputs only' },
    },
    empty: {
      note: 'A successful read found no managed accounts or actions.',
      seed: seed('empty'),
      expect: { present: ['[role="dialog"]'], text: 'No managed account is ready.' },
    },
    'not-recorded': {
      note: 'The original native run was not recorded; no replacement run is selected.',
      seed: seed('not-recorded'),
      expect: {
        present: ['[data-kind="managed_access"]'],
        text: 'The original run was not recorded.',
      },
    },
    partial: {
      note: 'An existing exact-input grant is temporarily unavailable and remains selected until explicitly removed.',
      seed: seed('partial'),
      expect: { present: ['[role="dialog"]'], text: 'Exact inputs only · Unavailable' },
    },
    unavailable: {
      note: 'The native read failed. No empty or successful access state is invented.',
      seed: seed('unavailable'),
      failNext: ['read_managed_action_access'],
      expect: {
        present: ['[role="alert"]', '[data-testid="section-unavailable"]'],
        text: 'Access is unavailable.',
      },
    },
  },
};
