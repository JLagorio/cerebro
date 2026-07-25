import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { nextItemKey } from '@/engine/itemKeys';
import { formatWikilink } from '@/engine/wikilink';
import { slugify } from '@/lib/slug';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

const pathStem = (p: string) => (p.split('/').pop() ?? p).replace(/\.md$/, '');

/** Prototype STATUS_PRESETS (docs/cerebro-with-teams/cerebro-work-data.js); `name` keys become `label`. */
export const STATUS_TEMPLATES = {
  cerebro: [
    { id: 'backlog', label: 'Backlog', group: 'active', color: 'var(--n-400)', hollow: true },
    { id: 'todo', label: 'Todo', group: 'active', color: 'var(--n-500)' },
    { id: 'progress', label: 'In progress', group: 'active', color: 'var(--warn-500)' },
    { id: 'review', label: 'In review', group: 'active', color: 'var(--swatch-sky)' },
    { id: 'done', label: 'Done', group: 'done', color: 'var(--success-500)' },
    { id: 'cancelled', label: 'Cancelled', group: 'closed', color: 'var(--n-400)' },
  ],
  marketing: [
    { id: 'idea', label: 'Idea', group: 'active', color: 'var(--n-400)', hollow: true },
    { id: 'drafting', label: 'Drafting', group: 'active', color: 'var(--warn-500)' },
    { id: 'review', label: 'In review', group: 'active', color: 'var(--swatch-sky)' },
    { id: 'scheduled', label: 'Scheduled', group: 'active', color: 'var(--cortex-400)' },
    { id: 'live', label: 'Live', group: 'done', color: 'var(--success-500)' },
    { id: 'killed', label: 'Killed', group: 'closed', color: 'var(--n-400)' },
  ],
  simple: [
    { id: 'todo', label: 'Todo', group: 'active', color: 'var(--n-500)', hollow: true },
    { id: 'doing', label: 'Doing', group: 'active', color: 'var(--warn-500)' },
    { id: 'done', label: 'Done', group: 'done', color: 'var(--success-500)' },
    { id: 'dropped', label: 'Dropped', group: 'closed', color: 'var(--n-400)' },
  ],
};

/** The 8 DS user-assignable swatches (tokens/colors.css). */
export const USER_SWATCHES = [
  'var(--swatch-amber)',
  'var(--swatch-blue)',
  'var(--swatch-teal)',
  'var(--swatch-green)',
  'var(--swatch-violet)',
  'var(--swatch-magenta)',
  'var(--swatch-vermilion)',
  'var(--swatch-sky)',
];

type CreateDialog = 'item' | 'project' | 'space' | null;

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
            className="fixed inset-0 z-40 cursor-default bg-transparent"
          />
          <div className="absolute right-0 top-full z-50 mt-1 w-44 rounded-[10px] border border-[var(--n-200)] bg-[var(--n-0)] p-1.5 shadow-[var(--shadow-md)]">
            <MenuEntry label="New item" icon="circle-check" onClick={() => openDialog('item')} />
            <MenuEntry label="New project" icon="folder" onClick={() => openDialog('project')} />
            <MenuEntry label="New space" icon="box" onClick={() => openDialog('space')} />
          </div>
        </>
      )}
      {dialog === 'item' && <NewItemDialog onClose={() => setDialog(null)} />}
      {dialog === 'project' && <NewProjectDialog onClose={() => setDialog(null)} />}
      {dialog === 'space' && <NewSpaceDialog onClose={() => setDialog(null)} />}
    </div>
  );
}

function NewItemDialog({ onClose }: { onClose: () => void }) {
  const entries = useVaultStore((s) => s.entries);
  const createItem = useVaultStore((s) => s.createItem);
  const openDetail = useUiStore((s) => s.openDetail);
  const projects = entries.filter((e) => e.type === 'Project');
  const [title, setTitle] = useState('');
  const [projectPath, setProjectPath] = useState(projects[0]?.path ?? '');

  const create = async () => {
    const trimmed = title.trim();
    const project = entries.find((e) => e.path === projectPath);
    if (trimmed === '' || !project) return;
    const prefix = typeof project.properties.key === 'string' ? project.properties.key : 'WRK';
    let path: string;
    try {
      path = await createItem({
        folder: 'items',
        slug: slugify(trimmed),
        frontmatter: {
          type: 'Work item',
          key: nextItemKey(prefix, entries),
          project: formatWikilink(pathStem(project.path)),
        },
      });
    } catch {
      // Deviation from the plan's verbatim body (execution-log notes 16a/17b,
      // reported): createItem throws to callers by design — surface the
      // failure and keep the dialog open instead of leaving an unhandled
      // rejection.
      useUiStore.getState().toast(`Couldn't create "${trimmed}"`);
      return;
    }
    onClose();
    openDetail(path);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="New item"
      primaryAction={{
        label: 'Create item',
        onClick: () => void create(),
        disabled: title.trim() === '' || projectPath === '',
      }}
      secondaryAction={{ label: 'Cancel', onClick: onClose }}
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-[12px] text-[var(--n-600)]">
          Title
          <Input autoFocus placeholder="What needs doing?" value={title} onChange={(e) => setTitle(e.target.value)} width="100%" />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-[var(--n-600)]">
          Project
          <Select
            options={projects.map((p) => ({ value: p.path, label: p.title }))}
            value={projectPath}
            onChange={(e) => setProjectPath(e.target.value)}
            width="100%"
          />
        </label>
      </div>
    </Dialog>
  );
}

function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const entries = useVaultStore((s) => s.entries);
  const createItem = useVaultStore((s) => s.createItem);
  const navigate = useNavStore((s) => s.navigate);
  const spaces = entries.filter((e) => e.type === 'Space');
  const [name, setName] = useState('');
  const [prefix, setPrefix] = useState('');
  const [spacePath, setSpacePath] = useState(spaces[0]?.path ?? '');
  const prefixValid = /^[A-Z]{2,4}$/.test(prefix);

  const create = async () => {
    const trimmed = name.trim();
    if (trimmed === '' || !prefixValid || spacePath === '') return;
    let path: string;
    try {
      path = await createItem({
        folder: 'projects',
        slug: slugify(trimmed),
        frontmatter: { type: 'Project', key: prefix, space: formatWikilink(pathStem(spacePath)) },
      });
    } catch {
      // Deviation (execution-log notes 16a/17b, reported): surface the failed
      // write and keep the dialog open.
      useUiStore.getState().toast(`Couldn't create "${trimmed}"`);
      return;
    }
    onClose();
    navigate({ kind: 'project', path });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="New project"
      primaryAction={{
        label: 'Create project',
        onClick: () => void create(),
        disabled: name.trim() === '' || !prefixValid || spacePath === '',
      }}
      secondaryAction={{ label: 'Cancel', onClick: onClose }}
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-[12px] text-[var(--n-600)]">
          Name
          <Input autoFocus placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} width="100%" />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-[var(--n-600)]">
          Key prefix
          <Input
            placeholder="e.g. FLD"
            value={prefix}
            onChange={(e) => setPrefix(e.target.value.toUpperCase().slice(0, 4))}
            width={120}
          />
          {prefix !== '' && !prefixValid && (
            <span className="text-[11px] text-[var(--danger-500)]">Use 2-4 uppercase letters, e.g. FLD</span>
          )}
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-[var(--n-600)]">
          Space
          <Select
            options={spaces.map((s) => ({ value: s.path, label: s.title }))}
            value={spacePath}
            onChange={(e) => setSpacePath(e.target.value)}
            width="100%"
          />
        </label>
      </div>
    </Dialog>
  );
}

function NewSpaceDialog({ onClose }: { onClose: () => void }) {
  const createItem = useVaultStore((s) => s.createItem);
  const navigate = useNavStore((s) => s.navigate);
  const [name, setName] = useState('');
  const [swatch, setSwatch] = useState(USER_SWATCHES[0]);
  const [template, setTemplate] = useState<keyof typeof STATUS_TEMPLATES>('cerebro');

  const create = async () => {
    const trimmed = name.trim();
    if (trimmed === '') return;
    let path: string;
    try {
      path = await createItem({
        folder: 'spaces',
        slug: slugify(trimmed),
        frontmatter: {
          type: 'Space',
          color: swatch,
          statuses: STATUS_TEMPLATES[template].map((s) => ({ ...s })),
        },
      });
    } catch {
      // Deviation (execution-log notes 16a/17b, reported): surface the failed
      // write and keep the dialog open.
      useUiStore.getState().toast(`Couldn't create "${trimmed}"`);
      return;
    }
    onClose();
    navigate({ kind: 'space', path });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="New space"
      primaryAction={{ label: 'Create space', onClick: () => void create(), disabled: name.trim() === '' }}
      secondaryAction={{ label: 'Cancel', onClick: onClose }}
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-[12px] text-[var(--n-600)]">
          Name
          <Input autoFocus placeholder="Space name" value={name} onChange={(e) => setName(e.target.value)} width="100%" />
        </label>
        <div className="flex flex-col gap-1 text-[12px] text-[var(--n-600)]">
          Color
          <div className="flex items-center gap-2">
            {USER_SWATCHES.map((s) => {
              const swatchName = s.replace('var(--swatch-', '').replace(')', '');
              return (
                <button
                  key={s}
                  type="button"
                  aria-label={`Color ${swatchName}`}
                  aria-pressed={s === swatch}
                  onClick={() => setSwatch(s)}
                  className="h-6 w-6 rounded-md"
                  style={{
                    background: s,
                    boxShadow: s === swatch ? `0 0 0 2px var(--n-0), 0 0 0 4px ${s}` : undefined,
                  }}
                />
              );
            })}
          </div>
        </div>
        {/* Deviation from the plan's verbatim JSX (reported): the plan's
            wrapping <label> PLUS aria-label made getByLabelText match two
            elements (the label itself and the wrapped select) — the plan's own
            note sanctions adjusting this query seam. The wrapping label alone
            associates the select. */}
        <label className="flex flex-col gap-1 text-[12px] text-[var(--n-600)]">
          Status template
          <Select
            options={[
              { value: 'cerebro', label: 'Cerebro flow' },
              { value: 'marketing', label: 'Marketing' },
              { value: 'simple', label: 'Simple' },
            ]}
            value={template}
            onChange={(e) => setTemplate(e.target.value as keyof typeof STATUS_TEMPLATES)}
            width="100%"
          />
        </label>
      </div>
    </Dialog>
  );
}
