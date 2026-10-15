import { ClientAccessSettings } from '@/app/ClientAccessSettings';
import { __seedClientTokens } from '@/lib/mockIpc';
import { useClientAccessStore } from '@/stores/clientAccessStore';
import type { LabSection } from '../presets';
const seed = (count: number) => () => {
  useClientAccessStore.getState().reset(null);
  __seedClientTokens(count);
};
export const section: LabSection = {
  id: 'client-access',
  title: 'Other apps',
  surface: 'Settings',
  render: () => <ClientAccessSettings />,
  states: {
    ready: {
      note: 'Two apps hold tokens; the listener is off.',
      seed: seed(2),
      expect: {
        present: ['[data-testid="client-token"]'],
        absent: ['[data-testid="section-unavailable"]'],
        text: 'App 2',
      },
    },
    empty: {
      note: 'No app has a token.',
      seed: seed(0),
      expect: {
        present: ['[data-testid="client-access"]'],
        absent: ['[data-testid="client-token"]', '[data-testid="section-unavailable"]'],
        text: 'No app has a token yet.',
      },
    },
    'not-recorded': {
      note: 'A token has no recorded last-use time.',
      seed: seed(1),
      expect: { present: ['[data-testid="client-token"]'], text: 'Never used' },
    },
    partial: {
      note: 'Token metadata is available, but the connection-status read failed.',
      seed: seed(1),
      failNext: ['client_access_status'],
      expect: {
        present: ['[data-testid="client-token"]', '[data-testid="section-unavailable"]'],
        text: "Couldn't read whether other apps can connect.",
      },
    },
    unavailable: {
      note: 'The token read failed; this is not an empty token list.',
      seed: seed(1),
      failNext: ['client_tokens'],
      expect: {
        present: ['[data-testid="section-unavailable"]'],
        absent: ['[data-testid="client-token"]'],
        text: "Couldn't read tokens.",
      },
    },
  },
};
