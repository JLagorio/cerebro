import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { MountRefusal } from '@/engine/roots';
import { useRootsStore } from '@/stores/rootsStore';

/** Injected so tests drive it without the Tauri dialog plugin. */
async function pickDirectory(): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ directory: true, multiple: false });
  return typeof picked === 'string' ? picked : null;
}

interface Props {
  onClose(): void;
  pickPath?: () => Promise<string | null>;
}

export function RootMountDialog({ onClose, pickPath = pickDirectory }: Props) {
  const mount = useRootsStore((s) => s.mount);
  const [refusal, setRefusal] = useState<MountRefusal | null>(null);

  const choose = async (): Promise<void> => {
    const path = await pickPath();
    if (path === null) return;
    const result = await mount(path);
    // The refusal is RENDERED, not toasted: "another root already holds the
    // knowledge base" is a decision the user has to see and act on.
    if (result !== null) {
      setRefusal(result);
      return;
    }
    onClose();
  };

  return (
    <div
      data-testid="mount-dialog"
      className="absolute inset-0 z-20 flex items-center justify-center bg-[rgba(0,0,0,0.25)]"
    >
      <div className="flex w-[420px] max-w-[90vw] flex-col gap-3 rounded-lg border border-n-200 bg-n-0 p-4 shadow-lg">
        <div className="flex items-center gap-2">
          <Icon name="folder-plus" size={16} color="var(--n-600)" />
          <h2 className="m-0 text-sm font-semibold">Mount a folder</h2>
        </div>
        <p className="m-0 text-sm text-n-600">
          Pick a folder that is already on disk. Cerebro never clones it, moves it, or writes to it.
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="mount-choose"
            onClick={() => void choose()}
            className="rounded-md border border-n-200 bg-n-0 px-3 py-1.5 text-sm hover:bg-n-50"
          >
            Choose folder…
          </button>
          <button
            type="button"
            data-testid="mount-cancel"
            onClick={onClose}
            className="rounded-md border-0 bg-transparent px-3 py-1.5 text-sm text-n-600 hover:text-n-900"
          >
            Cancel
          </button>
        </div>
        {refusal !== null && (
          <p
            data-testid="mount-refusal"
            data-code={refusal.code}
            className="m-0 rounded-md bg-n-50 p-2 text-sm text-[var(--danger,#b42318)]"
          >
            {refusal.message}
          </p>
        )}
      </div>
    </div>
  );
}
