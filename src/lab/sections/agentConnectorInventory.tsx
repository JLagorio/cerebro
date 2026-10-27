import { AgentProperties } from '@/library/AgentProperties';
import { saveConnectors } from '@/lib/mockIpc';
import { makeEntry } from '@/engine/testHelpers';
import { LAB_VAULT, type LabSection } from '../presets';

let grants: string[] = [];
const config = JSON.stringify({
  servers: {
    github: { transport: 'http', url: 'https://example.test/mcp', enabled: true },
  },
});
const seed = (raw: string, connectors: string[]) => () => {
  grants = connectors;
  void saveConnectors(LAB_VAULT, raw);
};
const state = (name: string) => `[data-testid="agent-connector-inventory"][data-state="${name}"]`;

export const section: LabSection = {
  id: 'agent-connector-inventory',
  title: 'Agent connector inventory',
  surface: 'Agent page › Properties',
  render: () => (
    <AgentProperties
      entry={makeEntry({
        path: 'agents/lab-scout.md',
        type: 'Agent',
        title: 'Lab scout',
        properties: { connectors: grants },
      })}
    />
  ),
  states: {
    ready: {
      note: 'The configured connector matches the stored grant; this makes no authentication claim.',
      seed: seed(config, ['github']),
      expect: { present: [state('ready')], text: '1 connector enabled in this vault.' },
    },
    empty: {
      note: 'The connector configuration was read successfully and contains no enabled servers.',
      seed: seed('{"servers":{}}', []),
      expect: { present: [state('empty')], text: 'This vault has no connectors enabled.' },
    },
    'not-recorded': {
      note: 'No connector configuration has been recorded for this vault.',
      seed: seed('', []),
      expect: { present: [state('not-recorded')], text: 'Connector configuration not recorded.' },
    },
    partial: {
      note: 'One configured connector remains available; another stored grant is kept but unavailable.',
      seed: seed(config, ['github', 'missing']),
      expect: {
        present: [state('partial')],
        text: 'Some granted connectors are not enabled here: missing.',
      },
    },
    unavailable: {
      note: 'The actual inventory read fails; the stored grants remain and Retry does not rewrite them.',
      seed: seed(config, ['github']),
      failNext: ['read_connectors'],
      expect: {
        present: [state('unavailable'), '[data-testid="section-unavailable"]'],
        text: 'Connector inventory unavailable.',
      },
    },
  },
};
