import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { nextItemKey } from '@/engine/itemKeys';
import { slugify } from '@/lib/slug';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/** Vault format v2: a project is a folder; its metadata doc is the folder's
 * project.md and its items live under `<folder>/items/`. */
const projectDir = (projectPath: string) => projectPath.replace(/\/project\.md$/, '');

type CreateDialog = 'item' | 'project' | null;

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
          </div>
        </>
      )}
      {dialog === 'item' && <NewItemDialog onClose={() => setDialog(null)} />}
      {dialog === 'project' && <NewProjectDialog onClose={() => setDialog(null)} />}
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
  // Fix (fix round M1): a double-click while the write was pending called
  // createItem twice with identical keys — two files, duplicate `key:`.
  const [submitting, setSubmitting] = useState(false);

  const create = async () => {
    const trimmed = title.trim();
    const project = entries.find((e) => e.path === projectPath);
    if (trimmed === '' || !project || submitting) return;
    setSubmitting(true);
    const prefix = typeof project.properties.key === 'string' ? project.properties.key : 'WRK';
    const key = nextItemKey(prefix, entries);
    let path: string;
    try {
      // v2: the item lands inside the project's folder — membership is
      // containment, no `project:` wikilink. Slug falls back to the key for
      // all-symbol titles; the body carries the typed title verbatim.
      path = await createItem({
        folder: `${projectDir(project.path)}/items`,
        slug: slugify(trimmed) || key.toLowerCase(),
        frontmatter: { type: 'Work item', key },
        body: `# ${trimmed}\n`,
      });
    } catch {
      // createItem throws to callers by design — surface the failure and keep
      // the dialog open instead of leaving an unhandled rejection (16a/17b).
      useUiStore.getState().toast(`Couldn't create "${trimmed}"`);
      setSubmitting(false); // draft stays editable for retry
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
        disabled: title.trim() === '' || projectPath === '' || submitting,
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
          {projects.length === 0 && (
            // Fresh-vault dead-end (M1.x): explain why Create stays disabled.
            <span className="text-[11px] text-[var(--n-500)]">
              No projects yet — create a project first.
            </span>
          )}
        </label>
      </div>
    </Dialog>
  );
}

export function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const entries = useVaultStore((s) => s.entries);
  const createItem = useVaultStore((s) => s.createItem);
  const navigate = useNavStore((s) => s.navigate);
  const [name, setName] = useState('');
  const [prefix, setPrefix] = useState('');
  // Fix (fix round M1): see NewItemDialog.
  const [submitting, setSubmitting] = useState(false);
  const prefixValid = /^[A-Z]{2,4}$/.test(prefix);

  const create = async () => {
    const trimmed = name.trim();
    if (trimmed === '' || !prefixValid || submitting) return;
    setSubmitting(true);
    // v2: a project is `projects/<slug>/project.md`. create_note dedupes the
    // FILE slug only, so dedupe the folder here against existing projects.
    const base = slugify(trimmed) || prefix.toLowerCase();
    const taken = new Set(
      entries
        .filter((e) => e.path.endsWith('/project.md'))
        .map((e) => e.folder.split('/').pop() ?? ''),
    );
    let folderSlug = base;
    for (let n = 2; taken.has(folderSlug); n++) folderSlug = `${base}-${n}`;
    let path: string;
    try {
      path = await createItem({
        folder: `projects/${folderSlug}`,
        slug: 'project',
        frontmatter: { type: 'Project', key: prefix },
        body: `# ${trimmed}\n`,
      });
    } catch {
      // Surface the failed write and keep the dialog open (16a/17b).
      useUiStore.getState().toast(`Couldn't create "${trimmed}"`);
      setSubmitting(false); // draft stays editable for retry
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
        disabled: name.trim() === '' || !prefixValid || submitting,
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
      </div>
    </Dialog>
  );
}
