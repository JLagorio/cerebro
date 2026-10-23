import { newSheetSource } from '@/engine/sheet/gridEdit';
import { useState } from 'react';
import { useOpenPath } from '@/app/useOpenPath';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Tooltip } from '@/components/ui/Tooltip';
import { slugify } from '@/lib/slug';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { useLauncherStore } from '@/stores/launcherStore';
import { RecordComposer } from '@/app/RecordComposer';

/** The sidebar door; the launcher itself lives at the app root. */
export function CreateMenu() {
  const open = useLauncherStore((s) => s.open);
  const openLauncher = useLauncherStore((s) => s.openLauncher);
  return (
    <Tooltip label="New" command="create.launcher" disabled={open}>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(event) => {
          event.currentTarget.focus();
          openLauncher();
        }}
        className="cb-context-create flex h-8 w-full items-center gap-[9px] rounded-md border border-n-200 bg-n-0 px-2 text-left text-sm font-medium text-n-800 hover:bg-n-100"
      >
        <Icon name="plus" size={15} color="var(--n-500)" />
        New
      </button>
    </Tooltip>
  );
}

/** The shared composer also accepts the Knowledge page's suggested title. */
export function NewRecordDialog({
  defaultTitle = '',
  onClose,
}: {
  defaultTitle?: string;
  onClose: () => void;
}) {
  return <RecordComposer defaultTitle={defaultTitle} onClose={onClose} />;
}

export function NewDocDialog({ onClose, sheet = false }: { onClose: () => void; sheet?: boolean }) {
  const createItem = useVaultStore((s) => s.createItem);
  const openPath = useOpenPath();
  const [title, setTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const create = async () => {
    const trimmed = title.trim();
    if (trimmed === '' || submitting) return;
    setSubmitting(true);
    const vault = useVaultStore.getState().vaultPath;
    let path: string;
    try {
      // An untyped page starts at the root and can be moved later.
      path = await createItem({
        folder: '',
        slug: slugify(trimmed) || `doc-${Date.now().toString(36)}`,
        frontmatter: {},
        body: sheet
          ? `# ${trimmed}\n\n\`\`\`cerebro-sheet\n${newSheetSource('Sheet1')}\`\`\`\n`
          : `# ${trimmed}\n`,
      });
    } catch {
      useUiStore.getState().toast(`Couldn't create "${trimmed}"`);
      setSubmitting(false);
      return;
    }
    if (useVaultStore.getState().vaultPath !== vault) return;
    onClose();
    openPath(path);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={sheet ? 'New sheet' : 'New page'}
      primaryAction={{
        label: sheet ? 'Create' : 'Create page',
        onClick: () => void create(),
        disabled: title.trim() === '' || submitting,
      }}
      secondaryAction={{ label: 'Cancel', onClick: onClose }}
    >
      <label className="flex flex-col gap-1 text-xs text-n-600">
        {sheet ? 'Name' : 'Title'}
        <Input
          autoFocus
          placeholder={sheet ? 'Name the page' : 'Page title'}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          width="100%"
        />
      </label>
    </Dialog>
  );
}
