import { useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { addRecipes, missingRecipes } from '@/lib/recipes';
import { useVaultStore } from '@/stores/vaultStore';

export function RecipesOffer() {
  const vault = useVaultStore((s) => s.vaultPath);
  const entriesVault = useVaultStore((s) => s.entriesVault);
  const entries = useVaultStore((s) => s.entries);
  const status = useVaultStore((s) => s.status);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const add = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await addRecipes();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  if (!vault) return null;
  if (status === 'error')
    return (
      <div className="mb-4 text-sm text-n-500" data-testid="recipes-offer">
        <p data-testid="section-unavailable">The library could not be read.</p>
        <Button size="sm" onClick={() => void useVaultStore.getState().rescan()}>
          Retry
        </Button>
      </div>
    );
  if (status !== 'ready' || entriesVault !== vault) return null;
  const missing = missingRecipes(entries);
  if (!missing.length) return null;
  return (
    <section
      className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-n-200 bg-n-50 p-4"
      data-testid="recipes-offer"
    >
      <p className="m-0 flex-1 text-sm text-n-600">
        Add {missing.map((recipe) => recipe.title).join(' and ')} as editable, read-only recipes.
      </p>
      <Button size="sm" disabled={busy} onClick={() => void add()}>
        {missing.length === 1 ? 'Add recipe' : 'Add recipes'}
      </Button>
    </section>
  );
}
