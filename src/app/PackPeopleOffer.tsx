import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { PEOPLE_PACK } from '@/engine/packPeople';
import { packPlanWords, planPack } from '@/engine/packs';
import { useVaultStore } from '@/stores/vaultStore';
import { installPack } from './packActions';
export function PackPeopleOffer() {
  const entries = useVaultStore((s) => s.entries);
  const [busy, setBusy] = useState(false);
  const plan = planPack(PEOPLE_PACK, entries);
  return (
    <section data-testid="pack-people" className="mt-4 border-t border-n-100 pt-4">
      <h3 className="m-0 mb-2 text-sm font-medium">People and companies</h3>
      <p className="text-xs text-n-500">
        Optional databases for people you know and companies you work with. Existing properties and
        views stay as written.
      </p>
      {packPlanWords(plan).map((words) => (
        <p className="my-1 text-xs text-n-600" key={words}>
          {words}
        </p>
      ))}
      {plan.ops.length > 0 && (
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void installPack().finally(() => setBusy(false));
          }}
        >
          {busy ? 'Installing…' : 'Install'}
        </Button>
      )}
    </section>
  );
}
