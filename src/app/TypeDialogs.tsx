import { useMemo, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { IconPicker } from '@/components/ui/IconPicker';
import { Input } from '@/components/ui/Input';
import { createDatabase, ensureTypeDoc, renameDatabase } from '@/app/typeActions';
import { trashPath } from '@/app/trashActions';
import type { TypeListing } from '@/engine/typeCatalog';
import { TRASH_WORDS } from '@/engine/trash';
import { isReservedTypeName, isSystemType, listTypes } from '@/engine/typeCatalog';
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

function useTypeNames(): Set<string> {
  const entries = useVaultStore((s) => s.entries);
  const schema = useSchema();
  return useMemo(
    () => new Set(listTypes(entries, schema).map((t) => t.name.toLowerCase())),
    [entries, schema],
  );
}

export function NewTypeDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavStore((s) => s.navigate);
  const taken = useTypeNames();
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const trimmed = name.trim();
  const duplicate = taken.has(trimmed.toLowerCase());
  // `listTypes` hides Collection, Skill and Agent, so `taken` alone let this
  // door declare a schema over them (`isReservedTypeName`).
  const reserved = !duplicate && isReservedTypeName(trimmed);

  const create = async () => {
    if (trimmed === '' || duplicate || reserved || submitting) return;
    setSubmitting(true);
    const vault = useVaultStore.getState().vaultPath;
    const created = await createDatabase(trimmed);
    if (created === null) {
      setSubmitting(false);
      return;
    }
    if (useVaultStore.getState().vaultPath !== vault) return;
    onClose();
    navigate({ kind: 'type', name: created });
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
        disabled: trimmed === '' || duplicate || reserved || submitting,
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
          {reserved && (
            <span className="text-2xs text-danger-500">
              "{trimmed}" is a name Cerebro reserves — choose another.
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
  const navigate = useNavStore((s) => s.navigate);
  const selection = useNavStore((s) => s.selection);
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
    isReservedTypeName(trimmed) ||
    isSystemType(listing.name);

  const rename = async () => {
    if (invalid || submitting) return;
    setSubmitting(true);
    if (!(await renameDatabase(listing, trimmed))) {
      setSubmitting(false);
      return;
    }
    onClose();
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
      footerNote={`Updates ${listing.count} records and every view, relation and page block that names it`}
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
  const [submitting, setSubmitting] = useState(false);

  // M60.8: the Type doc goes to the vault's own Trash. trashPath toasts,
  // rescans and never throws; a refusal keeps the dialog open.
  const remove = async () => {
    if (submitting || listing.docPath === null) return;
    setSubmitting(true);
    const item = await trashPath(listing.docPath, listing.name);
    if (item === null) {
      setSubmitting(false);
      return;
    }
    onClose();
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
      footerNote={TRASH_WORDS.footer}
    >
      <p className="m-0 text-sm leading-[19px] text-n-700">
        The database's schema document moves to the Trash.{' '}
        {listing.count > 0
          ? `${listing.count} ${listing.count === 1 ? 'record keeps' : 'records keep'} the "${listing.name}" tag but lose its properties and styling.`
          : 'No records use this database.'}
      </p>
    </Dialog>
  );
}
