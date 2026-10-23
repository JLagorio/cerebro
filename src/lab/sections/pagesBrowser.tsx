import { useEffect } from 'react';
import { PagesPage } from '@/pages/PagesPage';
import { armedFaults } from '@/lib/mockFaults';
import { __seedFileTimes } from '@/lib/mockIpc';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import type { LabSection } from '../presets';

function seed(count: number, unknownDate = false) {
  useNavStore.getState().reset();
  useNavStore.getState().navigate({ kind: 'pages' });
  const disk = (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
  disk.clear();
  if (count > 0) {
    disk.set('docs/brief.md', '# Design brief\n\nOur next release.\n');
    if (unknownDate) __seedFileTimes('docs/brief.md', { createdAt: '', modifiedAt: '' });
  }
  if (count > 1) disk.set('docs/release.md', '# Release notes\n\nReady to share.\n');
}

function Stage() {
  useEffect(() => {
    const vault = useVaultStore.getState().vaultPath;
    if (vault !== null && armedFaults().scan_vault !== undefined)
      void useVaultStore.getState().openVault(vault);
  }, []);
  return <PagesPage />;
}

const ITEM = '[data-testid="page-browser-item"]';
const UNAVAILABLE = '[data-testid="section-unavailable"]';
export const section: LabSection = {
  id: 'pages-browser',
  title: 'Pages browser',
  surface: 'Pages',
  render: () => <Stage />,
  states: {
    ready: {
      note: 'Two readable content pages.',
      seed: () => seed(2),
      expect: { present: [ITEM], absent: [UNAVAILABLE], text: 'Design brief' },
    },
    empty: {
      note: 'The vault read succeeded and contains no pages.',
      seed: () => seed(0),
      expect: {
        present: ['[data-state="empty"]'],
        absent: [ITEM, UNAVAILABLE],
        text: 'A place for your ideas',
      },
    },
    'not-recorded': {
      note: 'A readable page has no recorded edit timestamp.',
      seed: () => seed(1, true),
      expect: { present: [ITEM], absent: [UNAVAILABLE], text: 'Not recorded' },
    },
    partial: {
      note: 'Readable pages with a mix of recorded and absent edit timestamps.',
      seed: () => seed(2, true),
      expect: { present: [ITEM], absent: [UNAVAILABLE], text: 'Not recorded' },
    },
    unavailable: {
      note: 'The vault scan fails; existing rows cannot stand in for a current read.',
      seed: () => seed(2),
      failNext: ['scan_vault'],
      expect: { present: [UNAVAILABLE], absent: [ITEM], text: 'Pages couldn’t be loaded' },
    },
  },
};
