import { useEffect, useState } from 'react';
import { useVaultStore } from '@/stores/vaultStore';
import { subscribeRecovery } from './deletedDraftRecovery';
import { selectedTitleOwners, titleOwnerPresented } from './selectedTaskOwner';
import { SelectedTaskRecovery } from './SelectedTaskRecovery';
/** One presentation of the existing body owners, independent of cell lifetime. */
export function visibleTitleRecoveryOwners(vault:string|null) {
  if(vault===null)return [];
  return selectedTitleOwners(vault).filter(owner => {
    const state=owner.snapshot();
    return !titleOwnerPresented(owner)||state.selectedSave!==undefined||state.failure!==null||state.reconcileRequired;
  });
}
export function SelectedTitleRecoveryHost({embedded=false}:{embedded?:boolean}={}) {
  const vault = useVaultStore(state => state.vaultPath);
  const [, refresh] = useState(0);
  useEffect(() => subscribeRecovery(() => refresh(value => value + 1)), []);
  const owners = visibleTitleRecoveryOwners(vault);
  if (owners.length === 0) return null;
  const content=owners.map(owner => <SelectedTaskRecovery key={owner.key.vaultId + ':' + owner.key.path + ':' + owner.key.ownerId} owner={owner} kind="title" />);
  if(embedded)return <section aria-label="Title saves"><h2 className="m-0 text-sm font-medium text-n-800">Title saves</h2>{content}</section>;
  return <aside style={{maxWidth:'min(32rem, calc(100vw - 2rem))'}} aria-label="Title saves" className="fixed bottom-12 right-4 z-50 min-w-0 [overflow-wrap:anywhere] max-h-[70vh] max-w-lg overflow-auto rounded-md border border-n-200 bg-n-0 p-3 text-ui text-n-900 shadow-lg">
    {content}
  </aside>;
}
