import { useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
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
      className="mb-5 flex flex-wrap items-center gap-4 rounded-xl bg-n-50 px-5 py-4"
      data-testid="recipes-offer"
    >
      <Icon name="sparkles" size={20} color="var(--text-ai)" className="flex-none" />
      <div className="min-w-0 flex-1 basis-64">
        <p className="m-0 mb-1 text-sm font-medium text-n-800">A few useful starting points</p>
        <p className="m-0 text-xs leading-relaxed text-n-600">
          Add {missing.map((recipe) => recipe.title).join(', ')} as editable recipes. They only read
          your vault.
          {missing.some((recipe) => recipe.slug === 'draft-reply') &&
            ' Draft reply leaves a draft in Gmail for you to send.'}
        </p>
      </div>
      <Button size="sm" disabled={busy} onClick={() => void add()}>
        {missing.length === 1 ? 'Add recipe' : 'Add recipes'}
      </Button>
    </section>
  );
}
