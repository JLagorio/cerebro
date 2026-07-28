import { useMemo, useState } from 'react';
import { icons } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
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
  '#DE3B4E', '#DE8F0A', '#EFB428', '#1F9D61',
  '#3D8BE8', '#8B7CF6', '#EC4899', '#A8AFC2',
];

const DEFAULT_ICON = 'file-text';

/** lucide export names are PascalCase; Icon takes kebab-case. */
const kebab = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();

const ALL_ICONS = Object.keys(icons).map(kebab);

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
      title="Create new type"
      width={440}
      primaryAction={{
        label: 'Create',
        onClick: () => void create(),
        disabled: trimmed === '' || duplicate || submitting,
      }}
      secondaryAction={{ label: 'Cancel', onClick: onClose }}
    >
      <div className="flex flex-col gap-3">
        <p className="m-0 text-[13px] leading-[19px] text-[var(--n-600)]">
          A type is a document schema: notes of this type inherit its properties and styling.
        </p>
        <label className="flex flex-col gap-1 text-[12px] text-[var(--n-600)]">
          Type name
          <Input
            autoFocus
            placeholder="e.g. Recipe, Book, Habit…"
            value={name}
            onChange={(e) => setName(e.target.value)}
            width="100%"
          />
          {duplicate && (
            <span className="text-[11px] text-[var(--danger-500)]">
              A type named "{trimmed}" already exists.
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
  const duplicate = trimmed.toLowerCase() !== listing.name.toLowerCase() && taken.has(trimmed.toLowerCase());
  // System types are locked at the system level — the menu never offers
  // rename for them, but guard here too.
  const invalid =
    trimmed === '' || trimmed === listing.name || duplicate ||
    isSystemType(trimmed) || isSystemType(listing.name);

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
      footerNote={listing.count > 0 ? `Updates ${listing.count} ${listing.count === 1 ? 'record' : 'records'}` : undefined}
    >
      <label className="flex flex-col gap-1 text-[12px] text-[var(--n-600)]">
        Display name
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          width="100%"
        />
        {duplicate && (
          <span className="text-[11px] text-[var(--danger-500)]">
            A type named "{trimmed}" already exists.
          </span>
        )}
        {isSystemType(trimmed) && trimmed !== listing.name && (
          <span className="text-[11px] text-[var(--danger-500)]">
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
  const [query, setQuery] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = q === '' ? ALL_ICONS : ALL_ICONS.filter((n) => n.includes(q));
    return pool.slice(0, 96);
  }, [query]);

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
          <div className="mb-1.5 text-[12px] text-[var(--n-600)]">Color</div>
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
          <div className="mb-1.5 text-[12px] text-[var(--n-600)]">Icon</div>
          <Input
            placeholder="Search icons…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            width="100%"
          />
          <div className="mt-2 grid max-h-[180px] grid-cols-8 gap-1 overflow-y-auto">
            {matches.map((n) => (
              <button
                key={n}
                type="button"
                title={n}
                aria-label={`Icon ${n}`}
                aria-pressed={icon === n}
                onClick={() => setIcon(n)}
                className={[
                  'flex h-9 w-9 items-center justify-center rounded-md border',
                  icon === n
                    ? 'border-[var(--cortex-500)] bg-[var(--n-50)]'
                    : 'border-transparent hover:bg-[var(--n-50)]',
                ].join(' ')}
              >
                <Icon name={n} size={16} color={icon === n ? color : 'var(--n-600)'} />
              </button>
            ))}
            {matches.length === 0 && (
              <div className="col-span-8 py-3 text-center text-[12px] text-[var(--n-400)]">
                No icons match "{query}"
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-[var(--n-200)] bg-[var(--n-25)] px-3 py-2">
          <Icon name={icon} size={16} color={color} />
          <span className="text-[13px] text-[var(--n-800)]">{listing.name}</span>
          <span className="ml-auto text-[11px] text-[var(--n-400)]">Preview</span>
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
    toast(`Type "${listing.name}" deleted`);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Delete "${listing.name}"?`}
      width={440}
      primaryAction={{ label: 'Delete type', onClick: () => void remove(), disabled: submitting }}
      secondaryAction={{ label: 'Cancel', onClick: onClose }}
    >
      <p className="m-0 text-[13px] leading-[19px] text-[var(--n-700)]">
        The type document moves to the trash.{' '}
        {listing.count > 0
          ? `${listing.count} ${listing.count === 1 ? 'record keeps' : 'records keep'} the "${listing.name}" tag but lose its properties and styling.`
          : 'No records use this type.'}
      </p>
    </Dialog>
  );
}
