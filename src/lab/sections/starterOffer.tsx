import { StarterOffer } from '@/app/StarterOffer';
import { emptyMockVault } from '@/lib/mockIpc';
import type { LabSection } from '../presets';
const OFFER = '[data-testid="starter-offer"]';
const UNAVAILABLE = '[data-testid="section-unavailable"]';
export const section: LabSection = {
  id: 'starter-offer',
  title: 'Starter kit',
  surface: 'Home',
  render: () => <StarterOffer />,
  states: {
    ready: {
      note: 'An empty scanned vault has never been offered the kit.',
      seed: emptyMockVault,
      expect: { present: [OFFER], absent: [UNAVAILABLE], text: 'Add the starter kit' },
    },
    empty: {
      note: 'The vault already holds pages, so no offer is read.',
      expect: { present: [], absent: [OFFER, UNAVAILABLE] },
    },
    'not-recorded': {
      note: 'A legacy declined marker has no offered_at; it still counts.',
      seed: () => {
        emptyMockVault();
        (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs.set(
          '.cerebro/starter.json',
          '{"kit":1,"outcome":"declined"}',
        );
      },
      expect: { present: [], absent: [OFFER, UNAVAILABLE] },
    },
    partial: {
      note: 'Press Add: the install refuses once, leaving the offer and showing a toast.',
      seed: emptyMockVault,
      failNext: ['install_starter_kit'],
      expect: { present: [OFFER], absent: [UNAVAILABLE], text: 'Add the starter kit' },
    },
    unavailable: {
      note: 'The marker read failed; Retry reads it again.',
      seed: emptyMockVault,
      failNext: ['starter_marker'],
      expect: { present: [OFFER, UNAVAILABLE], text: 'The starter offer could not be read.' },
    },
  },
};
