import { useCallback } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { Icon } from '@/components/ui/Icon';
import { fileLook } from '@/engine/fileKinds';
import type { Selection } from '@/engine/types';
import { FileViewer } from '@/workspace/FileViewer';
import { noteFilePresence } from '@/app/filePresence';
import { readLastPlace, forgetLastPlace } from '@/app/lastPlace';
import { writePaneLayout } from '@/app/paneLayoutPersistence';
import { layoutOf, useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import '@/workspace/workspace.css';

export function FilePage({ selection }: { selection: Extract<Selection, { kind: 'file' }> }) {
  const vault = useVaultStore((s) => s.vaultPath);
  const path = selection.path;
  const name = path.split('/').at(-1) ?? path;
  const folder = path.slice(0, Math.max(0, path.lastIndexOf('/')));
  const presence = useCallback(
    (present: boolean) => {
      if (vault === null) return;
      noteFilePresence(vault, path, present);
      if (!present && useVaultStore.getState().vaultPath === vault) {
        const last = readLastPlace(vault);
        if (last?.kind === 'file' && last.path === path) forgetLastPlace(vault);
        writePaneLayout(vault, layoutOf(useNavStore.getState()));
      }
    },
    [vault, path],
  );
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="file-page">
      <PageHeader
        variant="tool"
        title={name}
        icon={<Icon name={fileLook(path).icon} size={18} />}
        description={folder ? <span data-testid="file-crumb">{folder}</span> : undefined}
      />
      <FileViewer rootId="0" path={path} onPresence={presence} />
    </div>
  );
}
