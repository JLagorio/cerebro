import { useEffect } from 'react';
import { RecipesOffer } from '@/library/RecipesOffer';
import { SHIPPED_RECIPES } from '@/lib/recipes';
import { armedFaults } from '@/lib/mockFaults';
import { useVaultStore } from '@/stores/vaultStore';
import type { LabSection } from '../presets';
const OFFER = '[data-testid="recipes-offer"]';
const UNAVAILABLE = '[data-testid="section-unavailable"]';
function addCopy(index: number, bytes?: string) {
  const recipe = SHIPPED_RECIPES[index];
  (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs.set(
    recipe.path,
    bytes ?? recipe.bytes,
  );
}
function Stage() {
  useEffect(() => {
    const vault = useVaultStore.getState().vaultPath;
    if (vault && armedFaults().scan_vault) void useVaultStore.getState().openVault(vault);
  }, []);
  return <RecipesOffer />;
}
export const section: LabSection = {
  id: 'recipes-offer',
  title: 'Recipes',
  surface: 'Library › Skills',
  render: () => <Stage />,
  states: {
    ready: {
      note: 'Catch me up is present; What I did is offered.',
      seed: () => addCopy(0),
      expect: { present: [OFFER], absent: [UNAVAILABLE], text: 'What I did' },
    },
    empty: {
      note: 'Both recipes are present; no offer remains.',
      seed: () => {
        addCopy(0);
        addCopy(1);
      },
      expect: { present: [], absent: [OFFER, UNAVAILABLE] },
    },
    'not-recorded': {
      note: 'A person edited the shipped path and removed its slug; it still counts.',
      seed: () => addCopy(0, '# My recap\n'),
      expect: { present: [OFFER], absent: [UNAVAILABLE], text: 'What I did' },
    },
    partial: {
      note: 'Press Add: the batch refuses once and leaves the offer.',
      failNext: ['apply_batch'],
      expect: { present: [OFFER], absent: [UNAVAILABLE], text: 'Add recipes' },
    },
    unavailable: {
      note: 'A failed scan cannot say which recipes are missing.',
      failNext: ['scan_vault'],
      expect: { present: [OFFER, UNAVAILABLE], text: 'The library could not be read.' },
    },
  },
};
