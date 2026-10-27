import { useSyncExternalStore } from 'react';
import { useVaultStore } from '@/stores/vaultStore';
import { recoveryEpoch, subscribeRecovery } from './deletedDraftRecovery';
import { SelectedTitleRecoveryHost, visibleTitleRecoveryOwners } from './SelectedTitleRecoveryHost';
import {
  SelectedMetadataRecoveryHost,
  visibleMetadataRecoveryOwners,
} from './SelectedMetadataRecoveryHost';
/** App owns one bounded position. Each domain keeps its existing model,
 * presentation and original-request authority independently. */
export function RetainedSavesHost() {
  const vault = useVaultStore((state) => state.vaultPath);
  useSyncExternalStore(subscribeRecovery, recoveryEpoch, recoveryEpoch);
  if (
    visibleTitleRecoveryOwners(vault).length === 0 &&
    visibleMetadataRecoveryOwners().length === 0
  )
    return null;
  return (
    <aside
      style={{ maxWidth: 'min(32rem, calc(100vw - 2rem))' }}
      aria-label="Retained page saves"
      className="fixed bottom-12 right-4 z-50 min-w-0 [overflow-wrap:anywhere] flex max-h-[70vh] max-w-lg flex-col gap-3 overflow-auto rounded-md border border-n-200 bg-n-0 p-3 text-ui text-n-900 shadow-lg"
    >
      <SelectedTitleRecoveryHost embedded />
      <SelectedMetadataRecoveryHost embedded />
    </aside>
  );
}
