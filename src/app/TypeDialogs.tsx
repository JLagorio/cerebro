import { useMemo, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { IconPicker } from '@/components/ui/IconPicker';
import { Input } from '@/components/ui/Input';
import { ensureTypeDoc } from '@/app/typeActions';
import type { TypeListing } from '@/engine/typeCatalog';
import { isSystemType, listTypes } from '@/engine/typeCatalog';
import { slugify } from '@/lib/slug';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';

/** The Tolaria-style 8-swatch palette for type colors. */
export const TYPE_COLORS = [
  '#DE3B4E',
  '#DE8F0A',
  '#EFB428',
  '#1F9D61',
  '#3D8BE8',
  '#8B7CF6',
  '#EC4899',
  '#A8AFC2',
];

const DEFAULT_ICON = 'file-text';

function useTypeNames(): Set<string> {
  const entries = useVaultStore((s) => s.entries);
  const schema = useSchema();
  return useMemo(
    () => new Set(listTypes(entries, schema).map((t) => t.name.toLowerCase())),
    [entries, schema],
  );
}

export function NewTypeDialog({ onClose }: { onClose: () => void }) {
  const createItem = useVaultStore((s) => s.createItem);
  const navigate = useNavStore((s) => s.navigate);
  const toast = useUiStore((s) => s.toast);
  const taken = useTypeNames();
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const trimmed = name.trim();
  const duplicate = taken.has(trimmed.toLowerCase());

  const create = async () => {
    if (trimmed === '' || duplicate || submitting) return;
    setSubmitting(true);
    try {
      await createItem({
        folder: 'types',
        slug: slugify(trimmed) || 'type',
        frontmatter: { type: 'Type', icon: DEFAULT_ICON, color: TYPE_COLORS[4] },
        body: `# ${trimmed}\n`,
      });
    } catch {
      toast(`Couldn't create type "${trimmed}"`);
      setSubmitting(false);
      return;
    }
    onClose();
    navigate({ kind: 'type', name: trimmed });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="New database"
      width={440}
      primaryAction={{
        label: 'Create',
        onClick: () => void create(),
        disabled: trimmed === '' || duplicate || submitting,
      }}
      secondaryAction={{ label: 'Cancel', onClick: onClose }}
    >
      <div className="flex flex-col gap-3">
        <p className="m-0 text-sm leading-[19px] text-n-600">
          A database is a schema for records: notes with its <code>type:</code> inherit its
          properties and styling.
        </p>
        <label className="flex flex-col gap-1 text-xs text-n-600">
          Database name
          <Input
            autoFocus
            placeholder="e.g. Recipe, Book, Habit…"
            value={name}
            onChange={(e) => setName(e.target.value)}
            width="100%"
          />
          {duplicate && (
            <span className="text-2xs text-danger-500">
              A database named "{trimmed}" already exists.
            </span>
          )}
        </label>
      </div>
    </Dialog>
  );
}

export function RenameTypeDialog({
  listing,
  onClose,
}: {
  listing: TypeListing;
  onClose: () => void;
}) {
  const entries = useVaultStore((s) => s.entries);
  const patchFrontmatter = useVaultStore((s) => s.patchFrontmatter);
  const navigate = useNavStore((s) => s.navigate);
  const selection = useNavStore((s) => s.selection);
  const toast = useUiStore((s) => s.toast);
  const taken = useTypeNames();
  const [name, setName] = useState(listing.name);
  const [submitting, setSubmitting] = useState(false);

  const trimmed = name.trim();
  const duplicate =
    trimmed.toLowerCase() !== listing.name.toLowerCase() && taken.has(trimmed.toLowerCase());
  // System types are locked at the system level — the menu never offers
  // rename for them, but guard here too.
  const invalid =
    trimmed === '' ||
    trimmed === listing.name ||
    duplicate ||
    isSystemType(trimmed) ||
    isSystemType(listing.name);

  const rename = async () => {
    if (invalid || submitting) return;
    setSubmitting(true);
    const { vaultPath, rescan } = useVaultStore.getState();
    try {
      const docPath = await ensureTypeDoc(listing);
      if (vaultPath !== null) {
        const ipc = await import('@/lib/ipc');
        await ipc.setNoteTitle(vaultPath, docPath, trimmed);
      }
      // Records reference types by name: retag every one so they follow.
      const records = entries.filter((e) => e.type === listing.name);
      for (const record of records) {
        await patchFrontmatter(record.path, { type: trimmed });
      }
      await rescan();
    } catch {
      toast(`Couldn't rename "${listing.name}"`);
      setSubmitting(false);
      return;
    }
    onClose();
    toast(`Renamed "${listing.name}" to "${trimmed}"`);
    if (selection.kind === 'type' && selection.name === listing.name) {
      navigate({ kind: 'type', name: trimmed });
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Change display name"
      width={440}
      primaryAction={{
        label: 'Rename',
        onClick: () => void rename(),
        disabled: invalid || submitting,
      }}
      secondaryAction={{ label: 'Cancel', onClick: onClose }}
      footerNote={
        listing.count > 0
          ? `Updates ${listing.count} ${listing.count === 1 ? 'record' : 'records'}`
          : undefined
      }
    >
      <label className="flex flex-col gap-1 text-xs text-n-600">
        Display name
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} width="100%" />
        {duplicate && (
          <span className="text-2xs text-danger-500">A type named "{trimmed}" already exists.</span>
        )}
        {isSystemType(trimmed) && trimmed !== listing.name && (
          <span className="text-2xs text-danger-500">
            "{trimmed}" is a reserved system type name.
          </span>
        )}
      </label>
    </Dialog>
  );
}

export function TypeStyleDialog({
  listing,
  onClose,
}: {
  listing: TypeListing;
  onClose: () => void;
}) {
  const patchFrontmatter = useVaultStore((s) => s.patchFrontmatter);
  const toast = useUiStore((s) => s.toast);
  const [color, setColor] = useState(listing.color ?? TYPE_COLORS[4]);
  const [icon, setIcon] = useState(listing.icon);
  const [submitting, setSubmitting] = useState(false);

  const save = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const docPath = await ensureTypeDoc(listing, { icon, color });
      if (listing.docPath !== null) {
        await patchFrontmatter(docPath, { icon, color });
      }
    } catch {
      toast(`Couldn't update "${listing.name}"`);
      setSubmitting(false);
      return;
    }
    onClose();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Customize ${listing.name}`}
      width={440}
      primaryAction={{ label: 'Done', onClick: () => void save(), disabled: submitting }}
      secondaryAction={{ label: 'Cancel', onClick: onClose }}
    >
      <div className="flex flex-col gap-4">
        <div>
          <div className="mb-1.5 text-xs text-n-600">Color</div>
          <div className="flex gap-2">
            {TYPE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Color ${c}`}
                aria-pressed={color === c}
                onClick={() => setColor(c)}
                className="h-7 w-7 rounded-full border-2"
                style={{
                  background: c,
                  borderColor: color === c ? 'var(--n-900)' : 'transparent',
                }}
              />
            ))}
          </div>
        </div>
        <div>
          <div className="mb-1.5 text-xs text-n-600">Icon</div>
          {/* M16.26: the grid this replaces was the app's only icon picker,
              inline and reachable from nothing else — which is why a view tab
              could not have an icon. It also offered every lucide export
              kebab-cased, including the dozen whose casing `Icon` cannot
              reproduce, so those tiles drew the dashed-square fallback and
              picking one wrote a dead name into the type's frontmatter. */}
          <IconPicker value={icon} onChange={setIcon} color={color} />
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-n-200 bg-n-25 px-3 py-2">
          <Icon name={icon} size={16} color={color} />
          <span className="text-sm text-n-800">{listing.name}</span>
          <span className="ml-auto text-2xs text-n-400">Preview</span>
        </div>
      </div>
    </Dialog>
  );
}

export function DeleteTypeDialog({
  listing,
  onClose,
}: {
  listing: TypeListing;
  onClose: () => void;
}) {
  const toast = useUiStore((s) => s.toast);
  const [submitting, setSubmitting] = useState(false);

  const remove = async () => {
    if (submitting || listing.docPath === null) return;
    setSubmitting(true);
    const { vaultPath, rescan } = useVaultStore.getState();
    try {
      if (vaultPath !== null) {
        const ipc = await import('@/lib/ipc');
        await ipc.deleteNote(vaultPath, listing.docPath);
      }
      await rescan();
    } catch {
      toast(`Couldn't delete "${listing.name}"`);
      setSubmitting(false);
      return;
    }
    onClose();
    toast(`Database "${listing.name}" deleted`);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Delete "${listing.name}"?`}
      width={440}
      primaryAction={{
        label: 'Delete database',
        onClick: () => void remove(),
        disabled: submitting,
      }}
      secondaryAction={{ label: 'Cancel', onClick: onClose }}
    >
      <p className="m-0 text-sm leading-[19px] text-n-700">
        The database's schema document moves to the trash.{' '}
        {listing.count > 0
          ? `${listing.count} ${listing.count === 1 ? 'record keeps' : 'records keep'} the "${listing.name}" tag but lose its properties and styling.`
          : 'No records use this database.'}
      </p>
    </Dialog>
  );
}
