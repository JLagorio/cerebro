import { useState } from 'react';
import { CollectionDialog } from '@/app/CollectionDialog';
import { useOpenPath } from '@/app/useOpenPath';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { createTarget } from '@/engine/createRecord';
import { typeStyle } from '@/engine/typeCatalog';
import { slugify } from '@/lib/slug';
import { useUiStore } from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';

type CreateDialog = 'record' | 'doc' | 'collection' | null;

function MenuEntry({ label, icon, onClick }: { label: string; icon: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-[7px] px-2 py-[7px] text-left text-[13px] text-[var(--n-800)] hover:bg-[var(--n-50)]"
    >
      <Icon name={icon} size={14} color="var(--n-500)" />
      {label}
    </button>
  );
}

/**
 * The New menu (M12.5 — the Notion model). Three things exist: a RECORD (a
 * page of a type), a DOC (untyped prose), and a COLLECTION (a container).
 * "New item" and "New project" died with the system types that defined them.
 */
export function CreateMenu() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<CreateDialog>(null);
  const openDialog = (d: CreateDialog) => {
    setMenuOpen(false);
    setDialog(d);
  };

  return (
    <div className="relative">
      <Button variant="primary" size="sm" icon="plus" onClick={() => setMenuOpen((v) => !v)}>
        New
      </Button>
      {menuOpen && (
        <>
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setMenuOpen(false)}
            onWheel={() => setMenuOpen(false)}
            className="fixed inset-0 z-40 cursor-default bg-transparent"
          />
          <div className="cb-menu-in absolute right-0 top-full z-50 mt-1 w-44 rounded-[10px] border border-[var(--n-200)] bg-[var(--n-0)] p-1.5 shadow-[var(--shadow-md)]">
            <MenuEntry
              label="New record"
              icon="circle-check"
              onClick={() => openDialog('record')}
            />
            <MenuEntry label="New doc" icon="file-text" onClick={() => openDialog('doc')} />
            <MenuEntry
              label="New collection"
              icon="folder-open"
              onClick={() => openDialog('collection')}
            />
          </div>
        </>
      )}
      {dialog === 'record' && <NewRecordDialog onClose={() => setDialog(null)} />}
      {dialog === 'doc' && <NewDocDialog onClose={() => setDialog(null)} />}
      {dialog === 'collection' && (
        <CollectionDialog state={{ mode: 'new' }} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

function NewRecordDialog({ onClose }: { onClose: () => void }) {
  const entries = useVaultStore((s) => s.entries);
  const createItem = useVaultStore((s) => s.createItem);
  const schema = useSchema();
  const openPath = useOpenPath();
  const types = [...schema.types.keys()].filter((t) => t !== 'Type').sort();
  const [title, setTitle] = useState('');
  const [typeName, setTypeName] = useState(types[0] ?? '');
  // Fix (fix round M1): a double-click while the write was pending created
  // the record twice.
  const [submitting, setSubmitting] = useState(false);

  const create = async () => {
    const trimmed = title.trim();
    if (trimmed === '' || typeName === '' || submitting) return;
    setSubmitting(true);
    // One rule for where records land (M12.2): the Type doc's folder, or
    // records/<plural>. The same createTarget every quick-add uses.
    const target = createTarget(typeName, { project: null, entries });
    let path: string;
    try {
      path = await createItem({
        folder: target.folder,
        slug: slugify(trimmed) || `record-${Date.now().toString(36)}`,
        frontmatter: target.frontmatter,
        body: `# ${trimmed}\n`,
      });
    } catch {
      useUiStore.getState().toast(`Couldn't create "${trimmed}"`);
      setSubmitting(false); // draft stays editable for retry
      return;
    }
    onClose();
    openPath(path);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="New record"
      primaryAction={{
        label: 'Create record',
        onClick: () => void create(),
        disabled: title.trim() === '' || typeName === '' || submitting,
      }}
      secondaryAction={{ label: 'Cancel', onClick: onClose }}
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-[12px] text-[var(--n-600)]">
          Title
          <Input
            autoFocus
            placeholder="What is it called?"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            width="100%"
          />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-[var(--n-600)]">
          Type
          <Select
            options={types.map((t) => ({ value: t, label: t }))}
            value={typeName}
            onChange={(e) => setTypeName(e.target.value)}
            width="100%"
          />
          {types.length === 0 && (
            <span className="text-[11px] text-[var(--n-500)]">
              No types yet — create one from the Types section of the sidebar first.
            </span>
          )}
        </label>
        {typeName !== '' && (
          <span className="inline-flex items-center gap-1.5 text-[11.5px] text-[var(--n-500)]">
            <Icon
              name={typeStyle(typeName, schema).icon}
              size={12}
              color={typeStyle(typeName, schema).color ?? 'var(--n-400)'}
            />
            Opens in the record panel, never in Docs.
          </span>
        )}
      </div>
    </Dialog>
  );
}

function NewDocDialog({ onClose }: { onClose: () => void }) {
  const createItem = useVaultStore((s) => s.createItem);
  const openPath = useOpenPath();
  const [title, setTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const create = async () => {
    const trimmed = title.trim();
    if (trimmed === '' || submitting) return;
    setSubmitting(true);
    let path: string;
    try {
      // Untyped, at the vault root: a doc is a doc, and it can be dragged
      // into any folder later — the tree is the file system.
      path = await createItem({
        folder: '',
        slug: slugify(trimmed) || `doc-${Date.now().toString(36)}`,
        frontmatter: {},
        body: `# ${trimmed}\n`,
      });
    } catch {
      useUiStore.getState().toast(`Couldn't create "${trimmed}"`);
      setSubmitting(false);
      return;
    }
    onClose();
    openPath(path);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="New doc"
      primaryAction={{
        label: 'Create doc',
        onClick: () => void create(),
        disabled: title.trim() === '' || submitting,
      }}
      secondaryAction={{ label: 'Cancel', onClick: onClose }}
    >
      <label className="flex flex-col gap-1 text-[12px] text-[var(--n-600)]">
        Title
        <Input
          autoFocus
          placeholder="Doc title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          width="100%"
        />
      </label>
    </Dialog>
  );
}
