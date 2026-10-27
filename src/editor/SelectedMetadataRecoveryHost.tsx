import { useSyncExternalStore } from 'react';
import { recoveryEpoch, subscribeRecovery } from './deletedDraftRecovery';
import { selectedMetadataOwners } from './selectedMetadataFieldOwner';
import { SelectedMetadataRecovery } from './SelectedMetadataRecovery';
/** Original-vault owners remain reachable even after the cell or vault leaves. */
export const visibleMetadataRecoveryOwners = () =>
  selectedMetadataOwners().filter((owner) => !owner.isPresented());
export function SelectedMetadataRecoveryHost({ embedded = false }: { embedded?: boolean } = {}) {
  useSyncExternalStore(subscribeRecovery, recoveryEpoch, recoveryEpoch);
  const owners = visibleMetadataRecoveryOwners();
  if (owners.length === 0) return null;
  const content = owners.map((owner) => (
    <SelectedMetadataRecovery
      key={owner.key.vaultId + ':' + owner.key.path + ':' + owner.key.ownerId}
      owner={owner}
    />
  ));
  if (embedded)
    return (
      <section aria-label="Property saves">
        <h2 className="m-0 text-sm font-medium text-n-800">Property saves</h2>
        {content}
      </section>
    );
  return (
    <aside
      style={{ maxWidth: 'min(32rem, calc(100vw - 2rem))' }}
      aria-label="Property saves"
      className="fixed bottom-12 right-4 z-50 min-w-0 [overflow-wrap:anywhere] max-h-[70vh] max-w-lg overflow-auto rounded-md border border-n-200 bg-n-0 p-3 text-ui text-n-900 shadow-lg"
    >
      {content}
    </aside>
  );
}
