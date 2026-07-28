import { useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { renameNote } from '@/lib/ipc';
import { humanizeSlug } from '@/lib/slug';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

const parentDir = (path: string): string =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

/**
 * Move a note or folder to another vault folder (M2.x docs polish). Shared
 * by the doc header action and the file-tree context menu.
 */
export function MoveDialog({
  path,
  label,
  onClose,
  onMoved,
}: {
  /** Vault-relative path of the note or folder being moved. */
  path: string;
  /** Human name shown in the dialog title. */
  label: string;
  onClose: () => void;
  /** Called with the subject's new path after a successful move. */
  onMoved: (newPath: string) => void;
}) {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const folders = useVaultStore((s) => s.folders);
  const rescan = useVaultStore((s) => s.rescan);
  const toast = useUiStore((s) => s.toast);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const targets = ['', ...folders].filter(
    (f) => f !== parentDir(path) && f !== path && !f.startsWith(`${path}/`),
  );

  const submit = async () => {
    if (selected === null || vaultPath === null || busy) return;
    setBusy(true);
    try {
      const name = path.split('/').pop() ?? path;
      const dest = selected === '' ? name : `${selected}/${name}`;
      await renameNote(vaultPath, path, dest);
      await rescan();
      onMoved(dest);
    } catch {
      toast("Couldn't move — does something with that name already exist there?");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Move ${label}`}
      width={440}
      primaryAction={{
        label: 'Move',
        onClick: () => void submit(),
        disabled: selected === null || busy,
      }}
      secondaryAction={{ label: 'Cancel', onClick: onClose }}
    >
      <div
        data-testid="move-target-list"
        className="flex max-h-[300px] flex-col gap-px overflow-y-auto rounded-lg border border-[var(--n-200)] p-1"
      >
        {targets.map((f) => (
          <button
            key={f === '' ? '/' : f}
            type="button"
            onClick={() => setSelected(f)}
            className={[
              'flex items-center gap-1.5 rounded-md border-0 px-2 py-1.5 text-left text-[13px]',
              selected === f
                ? 'bg-[var(--cortex-50)] font-medium text-[var(--cortex-600)]'
                : 'bg-transparent text-[var(--n-700)] hover:bg-[var(--n-50)]',
            ].join(' ')}
          >
            <Icon name="folder" size={14} color="var(--n-500)" />
            {f === '' ? 'Vault root' : f.split('/').map(humanizeSlug).join(' / ')}
          </button>
        ))}
      </div>
    </Dialog>
  );
}
