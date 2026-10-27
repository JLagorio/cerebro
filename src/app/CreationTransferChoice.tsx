import { createTarget } from '@/engine/createRecord';
import type { CreationDestination } from '@/engine/creationDestination';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import { Button } from '@/components/ui/Button';
import type { useCreationSession } from './useCreationSession';
export function CreationTransferChoice({
  session,
}: {
  session: ReturnType<typeof useCreationSession>;
}) {
  const entries = useVaultStore((state) => state.entries);
  const schema = useSchema();
  if (session.transfer === null) return null;
  const describe = (destination: CreationDestination): string => {
    if (destination.kind === 'page') return `In ${destination.folder || 'vault root'}`;
    const host = entries.find((entry) => entry.path === destination.host?.path);
    return `In ${destination.typeName} · ${createTarget(destination.typeName, { entries, schema }).folder}${destination.host === null ? '' : ` · Related to ${host?.title ?? destination.host.path}`}`;
  };
  return (
    <section aria-label="Change draft destination" className="my-3 flex flex-col gap-2">
      <p className="m-0 text-sm">
        Keep this draft at its current destination, or move it explicitly.
      </p>
      <p className="m-0 text-xs text-n-600">From: {describe(session.context.destination)}</p>
      <p className="m-0 text-xs font-medium text-n-800">
        To: {describe(session.transfer.destination)}
      </p>
      {session.transferError !== null && (
        <p role="status" className="m-0 text-xs text-danger-600">
          {session.transferError}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button onClick={session.move}>Move draft here</Button>
        <Button onClick={session.leaveAndStart}>Leave draft and start here</Button>
        <Button onClick={session.cancelTransfer}>Keep destination</Button>
      </div>
    </section>
  );
}
