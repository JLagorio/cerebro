import { useMemo, useState } from 'react';
import { MoveDialog } from '@/components/MoveDialog';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu';
import { Dialog } from '@/components/ui/Dialog';
import { Dropdown } from '@/components/ui/Dropdown';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import type { Entry } from '@/engine/types';
import { createFolder, deleteNote, readNote, renameNote } from '@/lib/ipc';
import { humanizeSlug, slugify } from '@/lib/slug';
import {
  applyTemplateBody,
  applyTemplateFrontmatter,
  listTemplates,
  templateDisplayName,
  todayIso,
} from '@/lib/templates';
import { typeStyle } from '@/engine/typeCatalog';
import { useUiStore } from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';

interface TreeNode {
  path: string;
  /** Slug basename — what rename operates on. */
  name: string;
  /** Human-readable row text: note titles for files, title-cased slugs for
   * folders (M2.x feedback: show "App Notes", never "app-notes"). */
  label: string;
  /** 'doc' = folder-note multi-page doc: the folder renders as a document
   * whose extra pages nest beneath it (M2.x docs polish). */
  kind: 'folder' | 'file' | 'doc';
  /** For 'doc' nodes: path of the folder note (the doc's default page). */
  mainPath?: string;
  children: TreeNode[];
}

const parentDir = (path: string) =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

function buildTree(
  root: string,
  entries: Entry[],
  folders: string[],
  hide: (path: string) => boolean,
  order: Record<string, string[]> = {},
): TreeNode[] {
  const prefix = root === '' ? '' : `${root}/`;
  const byPath = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];

  const attach = (node: TreeNode) => {
    const parent = parentDir(node.path);
    if (parent === root || !parent.startsWith(prefix)) roots.push(node);
    else ensureFolder(parent).children.push(node);
  };
  const ensureFolder = (path: string): TreeNode => {
    let node = byPath.get(path);
    if (node === undefined) {
      const name = path.split('/').pop() ?? path;
      node = { path, name, label: humanizeSlug(name), kind: 'folder', children: [] };
      byPath.set(path, node);
      attach(node);
    }
    return node;
  };

  for (const dir of folders) {
    if (dir.startsWith(prefix) && dir !== root && !hide(dir)) ensureFolder(dir);
  }
  for (const e of entries) {
    if (!e.path.startsWith(prefix) || hide(e.path)) continue;
    attach({
      path: e.path,
      name: e.filename.replace(/\.md$/, ''),
      label: e.title,
      kind: 'file',
      children: [],
    });
  }

  // Folder-note pass: a folder holding `<its-name>.md` renders as a doc.
  const promoteDocs = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      if (node.kind === 'folder') {
        const main = node.children.find(
          (c) => c.kind === 'file' && c.name === node.name,
        );
        if (main !== undefined) {
          node.kind = 'doc';
          node.mainPath = main.path;
          node.label = main.label; // the folder note's title names the doc
          node.children = node.children.filter((c) => c !== main);
        }
      }
      promoteDocs(node.children);
    }
  };
  promoteDocs(roots);

  // Manual drag order first (basenames, unknowns last), then folders-first
  // alphabetical.
  const sortNodes = (nodes: TreeNode[], dir: string) => {
    const custom = order[dir];
    nodes.sort((a, b) => {
      if (custom !== undefined) {
        const ai = custom.indexOf(a.name);
        const bi = custom.indexOf(b.name);
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
      }
      return (
        Number(a.kind !== 'folder') - Number(b.kind !== 'folder') ||
        a.label.localeCompare(b.label)
      );
    });
    for (const n of nodes) sortNodes(n.children, n.path);
  };
  sortNodes(roots, root);
  return roots;
}

type TreeDialog =
  | { mode: 'new-page'; dir: string }
  | { mode: 'new-folder'; dir: string }
  | { mode: 'rename'; node: TreeNode };

export interface FileTreeProps {
  /** Directory whose contents are shown ('' = whole vault). */
  root: string;
  /** Hide specific paths (e.g. the project.md that the Overview tab owns). */
  hide?: (path: string) => boolean;
  /** Currently open page — its row renders highlighted. */
  activePath?: string | null;
  /** A file row (or freshly created page) was chosen. */
  onOpen: (path: string) => void;
}

/** Folder/note tree over the vault (M2 Task 10): create, rename, move,
 * trash, templates; folder-note docs render as documents (M2.x). */
export function FileTree({ root, hide = () => false, activePath = null, onOpen }: FileTreeProps) {
  const entries = useVaultStore((s) => s.entries);
  const folders = useVaultStore((s) => s.folders);
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const rescan = useVaultStore((s) => s.rescan);
  const createItem = useVaultStore((s) => s.createItem);
  const expanded = useUiStore((s) => s.expandedFolders);
  const toggleFolder = useUiStore((s) => s.toggleFolder);
  const treeOrder = useUiStore((s) => s.treeOrder);
  const setTreeOrder = useUiStore((s) => s.setTreeOrder);
  const toast = useUiStore((s) => s.toast);

  const tree = useMemo(
    () => buildTree(root, entries, folders, hide, treeOrder),
    [root, entries, folders, hide, treeOrder],
  );
  const templates = useMemo(() => listTemplates(entries), [entries]);
  // M3: typed files carry their type's icon/color in the tree.
  const schema = useSchema();
  const entryByPath = useMemo(() => new Map(entries.map((e) => [e.path, e])), [entries]);

  const [dialog, setDialog] = useState<TreeDialog | null>(null);
  const [name, setName] = useState('');
  const [templatePath, setTemplatePath] = useState('none');
  const [submitting, setSubmitting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<TreeNode | null>(null);
  const [moveNode, setMoveNode] = useState<TreeNode | null>(null);
  // Task 14: right-click menu — node targets a row, node:null targets root.
  const [menu, setMenu] = useState<{ x: number; y: number; node: TreeNode | null } | null>(null);
  // Drag & drop (M2.x): drag any row; drop INTO folders/docs (moves the item
  // and everything inside it) or BETWEEN siblings (manual reorder).
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ path: string; mode: 'into' | 'before' | 'after' } | null>(null);

  /** Sibling list holding `dir`'s children in current display order. */
  const siblingsOf = (dir: string): TreeNode[] | null => {
    if (dir === root) return tree;
    const walk = (nodes: TreeNode[]): TreeNode[] | null => {
      for (const n of nodes) {
        if (n.path === dir) return n.children;
        const found = walk(n.children);
        if (found !== null) return found;
      }
      return null;
    };
    return walk(tree);
  };

  const stemOf = (path: string) => (path.split('/').pop() ?? path).replace(/\.md$/, '');

  const invalidDrop = (src: string, destDir: string) =>
    destDir === src || destDir.startsWith(`${src}/`);

  const moveInto = async (src: string, destDir: string) => {
    if (vaultPath === null || invalidDrop(src, destDir)) return;
    if (parentDir(src) === destDir) return; // already there
    const base = src.split('/').pop() ?? src;
    try {
      await renameNote(vaultPath, src, destDir === '' ? base : `${destDir}/${base}`);
      await rescan();
      if (!expanded[destDir]) toggleFolder(destDir);
    } catch {
      toast("Couldn't move here");
    }
  };

  const placeBeside = async (src: string, target: TreeNode, mode: 'before' | 'after') => {
    if (vaultPath === null) return;
    const destDir = parentDir(target.path);
    if (invalidDrop(src, destDir)) return;
    const srcStem = stemOf(src);
    try {
      if (parentDir(src) !== destDir) {
        const base = src.split('/').pop() ?? src;
        await renameNote(vaultPath, src, destDir === '' ? base : `${destDir}/${base}`);
        await rescan();
      }
      const siblings = siblingsOf(destDir);
      const names = (siblings ?? []).map((s) => s.name).filter((n) => n !== srcStem);
      if (!names.includes(target.name)) names.push(target.name);
      const at = names.indexOf(target.name) + (mode === 'after' ? 1 : 0);
      names.splice(at, 0, srcStem);
      setTreeOrder(destDir, names);
    } catch {
      toast("Couldn't move here");
    }
  };

  const onRowDragOver = (node: TreeNode) => (e: React.DragEvent) => {
    if (dragPath === null || dragPath === node.path) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - rect.top) / Math.max(rect.height, 1);
    const mode: 'into' | 'before' | 'after' =
      node.kind === 'file'
        ? y < 0.5 ? 'before' : 'after'
        : y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'into';
    setDropHint((prev) =>
      prev?.path === node.path && prev.mode === mode ? prev : { path: node.path, mode },
    );
  };

  const onRowDrop = (node: TreeNode) => (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const src = dragPath;
    const hint = dropHint;
    setDragPath(null);
    setDropHint(null);
    if (src === null || hint === null || hint.path !== node.path) return;
    if (hint.mode === 'into') void moveInto(src, node.path);
    else void placeBeside(src, node, hint.mode);
  };

  const openDialog = (d: TreeDialog) => {
    setDialog(d);
    setName(d.mode === 'rename' ? d.node.name : '');
    setTemplatePath('none');
  };
  const closeDialog = () => {
    setDialog(null);
    setName('');
  };

  const submitDialog = async () => {
    const trimmed = name.trim();
    if (dialog === null || vaultPath === null || trimmed === '' || submitting) return;
    setSubmitting(true);
    try {
      if (dialog.mode === 'new-page') {
        // Typed capitalization becomes the H1; the filename is the slug.
        const slug = slugify(trimmed) || 'page';
        const template = entries.find((e) => e.path === templatePath) ?? null;
        const vars = { title: trimmed, date: todayIso() };
        let body = `# ${trimmed}\n`;
        let frontmatter: Record<string, unknown> = {};
        if (template !== null) {
          body = applyTemplateBody(await readNote(vaultPath, template.path), vars);
          frontmatter = applyTemplateFrontmatter(template, vars);
        }
        const path = await createItem({ folder: dialog.dir, slug, frontmatter, body });
        closeDialog();
        onOpen(path);
        return;
      }
      if (dialog.mode === 'new-folder') {
        const slug = slugify(trimmed) || 'folder';
        const path = `${dialog.dir}/${slug}`;
        await createFolder(vaultPath, path);
        await rescan();
        // Reveal the new folder (and keep its parent open).
        if (!expanded[path]) toggleFolder(path);
        closeDialog();
        return;
      }
      const { node } = dialog;
      const slug = slugify(trimmed) || node.name;
      const to = `${parentDir(node.path)}/${slug}${node.kind === 'file' ? '.md' : ''}`;
      if (to !== node.path) {
        await renameNote(vaultPath, node.path, to);
        // Folder-note pattern: the doc's main file must keep the folder's
        // name or the folder stops being a doc.
        if (node.kind === 'doc' && node.mainPath !== undefined) {
          await renameNote(vaultPath, `${to}/${node.name}.md`, `${to}/${slug}.md`);
        }
        await rescan();
      }
      closeDialog();
    } catch {
      const verb =
        dialog.mode === 'rename' ? 'rename' : dialog.mode === 'new-page' ? 'create page' : 'create folder';
      toast(`Couldn't ${verb}`);
    } finally {
      setSubmitting(false);
    }
  };

  const submitDelete = async () => {
    if (confirmDelete === null || vaultPath === null || submitting) return;
    setSubmitting(true);
    try {
      await deleteNote(vaultPath, confirmDelete.path);
      await rescan();
      setConfirmDelete(null);
    } catch {
      toast("Couldn't move to Trash");
    } finally {
      setSubmitting(false);
    }
  };

  const menuItems = (node: TreeNode | null): ContextMenuItem[] => {
    const dir =
      node === null ? root : node.kind === 'file' ? parentDir(node.path) : node.path;
    const items: ContextMenuItem[] = [
      { icon: 'file-plus', label: 'New page', onSelect: () => openDialog({ mode: 'new-page', dir }) },
      {
        icon: 'folder-plus',
        label: 'New folder',
        onSelect: () => openDialog({ mode: 'new-folder', dir }),
      },
    ];
    if (node !== null) {
      items.push(
        { icon: 'pencil', label: 'Rename', onSelect: () => openDialog({ mode: 'rename', node }) },
        { icon: 'folder-input', label: 'Move to folder…', onSelect: () => setMoveNode(node) },
        {
          icon: 'trash-2',
          label: 'Move to Trash',
          danger: true,
          onSelect: () => setConfirmDelete(node),
        },
      );
    }
    return items;
  };

  const onRowContextMenu = (node: TreeNode | null) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, node });
  };

  const rowActions = (node: TreeNode) => (
    <span className="ml-auto hidden items-center gap-0.5 group-hover:inline-flex">
      {node.kind !== 'file' && (
        <IconButton
          icon="file-plus"
          label={`New page in ${node.label}`}
          size="sm"
          onClick={() => openDialog({ mode: 'new-page', dir: node.path })}
        />
      )}
      <span
        className="inline-flex"
        onClick={(e) => {
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY, node });
        }}
      >
        <IconButton icon="ellipsis" label={`Options for ${node.label}`} size="sm" />
      </span>
    </span>
  );

  const rowShell = (node: TreeNode, depth: number, active: boolean, inner: React.ReactNode) => {
    const hint = dropHint?.path === node.path ? dropHint.mode : null;
    return (
      <div
        data-testid="tree-row"
        data-path={node.path}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', node.path);
          setDragPath(node.path);
        }}
        onDragEnd={() => {
          setDragPath(null);
          setDropHint(null);
        }}
        onDragOver={onRowDragOver(node)}
        onDragLeave={() => setDropHint((p) => (p?.path === node.path ? null : p))}
        onDrop={onRowDrop(node)}
        className={[
          'group flex min-w-0 items-center gap-1 rounded-md pr-1',
          active ? 'bg-[var(--cortex-50)]' : 'hover:bg-[var(--n-100)]',
          hint === 'into' ? 'bg-[var(--cortex-50)] shadow-[inset_0_0_0_1.5px_var(--cortex-500)]' : '',
          hint === 'before' ? 'shadow-[inset_0_2px_0_var(--cortex-500)]' : '',
          hint === 'after' ? 'shadow-[inset_0_-2px_0_var(--cortex-500)]' : '',
          dragPath === node.path ? 'opacity-50' : '',
        ].join(' ')}
        style={{ paddingLeft: depth * 14 }}
        onContextMenu={onRowContextMenu(node)}
      >
        {inner}
        {rowActions(node)}
      </div>
    );
  };

  const renderNodes = (nodes: TreeNode[], depth: number): React.ReactNode =>
    nodes.map((node) => {
      const isOpen = expanded[node.path] === true;
      const active =
        (node.kind === 'file' && node.path === activePath) ||
        (node.kind === 'doc' && node.mainPath === activePath);
      const labelClass = [
        'truncate',
        active ? 'font-medium text-[var(--cortex-600)]' : '',
      ].join(' ');

      return (
        <li key={node.path} className="list-none">
          {node.kind === 'folder' &&
            rowShell(
              node,
              depth,
              false,
              <button
                type="button"
                data-testid="tree-folder"
                aria-expanded={isOpen}
                onClick={() => toggleFolder(node.path)}
                className="inline-flex min-w-0 flex-1 items-center gap-1.5 border-0 bg-transparent px-1 py-[5px] text-left text-[13px] text-[var(--n-800)]"
              >
                <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={13} color="var(--n-400)" />
                <Icon name={isOpen ? 'folder-open' : 'folder'} size={14} color="var(--n-500)" />
                <span className="truncate">{node.label}</span>
              </button>,
            )}
          {node.kind === 'doc' &&
            rowShell(
              node,
              depth,
              active,
              <span className="flex min-w-0 flex-1 items-center">
                <button
                  type="button"
                  aria-label={isOpen ? `Collapse ${node.label}` : `Expand ${node.label}`}
                  aria-expanded={isOpen}
                  onClick={() => toggleFolder(node.path)}
                  className="inline-flex flex-none items-center border-0 bg-transparent py-[5px] pl-1 pr-0.5 text-[var(--n-400)]"
                >
                  <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={13} />
                </button>
                <button
                  type="button"
                  data-testid="tree-doc"
                  onClick={() => node.mainPath !== undefined && onOpen(node.mainPath)}
                  className="inline-flex min-w-0 flex-1 items-center gap-1.5 border-0 bg-transparent py-[5px] pr-1 text-left text-[13px] text-[var(--n-700)]"
                >
                  <Icon name="file-stack" size={14} color={active ? 'var(--cortex-500)' : 'var(--n-500)'} />
                  <span className={labelClass}>{node.label}</span>
                </button>
              </span>,
            )}
          {node.kind === 'file' &&
            rowShell(
              node,
              depth,
              active,
              <button
                type="button"
                data-testid="tree-file"
                onClick={() => onOpen(node.path)}
                className="inline-flex min-w-0 flex-1 items-center gap-1.5 border-0 bg-transparent px-1 py-[5px] pl-[19px] text-left text-[13px] text-[var(--n-700)]"
              >
                {(() => {
                  const style = typeStyle(entryByPath.get(node.path)?.type ?? null, schema);
                  return (
                    <Icon
                      name={style.icon}
                      size={14}
                      color={active ? 'var(--cortex-500)' : (style.color ?? 'var(--n-500)')}
                    />
                  );
                })()}
                <span className={labelClass}>{node.label}</span>
              </button>,
            )}
          {node.kind !== 'file' && isOpen && node.children.length > 0 && (
            <ul className="m-0 p-0">{renderNodes(node.children, depth + 1)}</ul>
          )}
          {node.kind === 'folder' && isOpen && node.children.length === 0 && (
            <p
              className="m-0 py-1 text-[12px] text-[var(--n-400)]"
              style={{ paddingLeft: depth * 14 + 40 }}
            >
              Empty folder
            </p>
          )}
          {node.kind === 'doc' && isOpen && node.children.length === 0 && (
            <p
              className="m-0 py-1 text-[12px] text-[var(--n-400)]"
              style={{ paddingLeft: depth * 14 + 40 }}
            >
              No extra pages
            </p>
          )}
        </li>
      );
    });

  return (
    <div
      data-testid="file-tree"
      className="flex min-w-0 max-w-[720px] flex-col"
      onContextMenu={onRowContextMenu(null)}
    >
      <div className="mb-1.5 flex items-center gap-1">
        <button
          type="button"
          onClick={() => openDialog({ mode: 'new-page', dir: root })}
          className="inline-flex items-center gap-1 rounded-md border-0 bg-transparent px-1.5 py-1 text-[12px] text-[var(--n-500)] hover:bg-[var(--n-100)] hover:text-[var(--n-700)]"
        >
          <Icon name="file-plus" size={13} />
          New page
        </button>
        <button
          type="button"
          onClick={() => openDialog({ mode: 'new-folder', dir: root })}
          className="inline-flex items-center gap-1 rounded-md border-0 bg-transparent px-1.5 py-1 text-[12px] text-[var(--n-500)] hover:bg-[var(--n-100)] hover:text-[var(--n-700)]"
        >
          <Icon name="folder-plus" size={13} />
          New folder
        </button>
      </div>
      {tree.length === 0 ? (
        <p className="m-0 px-1.5 py-2 text-[13px] text-[var(--n-500)]">
          No pages yet. Use New page to write the first one.
        </p>
      ) : (
        <ul className="m-0 p-0">{renderNodes(tree, 0)}</ul>
      )}
      {menu !== null && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.node)}
          onClose={() => setMenu(null)}
        />
      )}
      {dialog !== null && (
        <Dialog
          open
          onClose={closeDialog}
          title={
            dialog.mode === 'new-page'
              ? 'New page'
              : dialog.mode === 'new-folder'
                ? 'New folder'
                : `Rename ${dialog.node.kind === 'folder' ? 'folder' : 'page'}`
          }
          width={420}
          primaryAction={{
            label: dialog.mode === 'rename' ? 'Rename' : 'Create',
            onClick: () => void submitDialog(),
            disabled: name.trim() === '' || submitting,
          }}
          secondaryAction={{ label: 'Cancel', onClick: closeDialog }}
        >
          <div className="flex flex-col gap-2">
            <Input
              autoFocus
              placeholder={dialog.mode === 'new-folder' ? 'Folder name' : 'Page name'}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitDialog();
              }}
              width="100%"
            />
            {dialog.mode === 'new-page' && templates.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="flex-none text-[12px] text-[var(--n-500)]">Template</span>
                <Dropdown
                  size="sm"
                  label="Template"
                  options={[
                    { value: 'none', label: 'Blank page' },
                    ...templates.map((t) => ({ value: t.path, label: templateDisplayName(t) })),
                  ]}
                  value={templatePath}
                  onChange={setTemplatePath}
                />
              </div>
            )}
          </div>
        </Dialog>
      )}
      {moveNode !== null && (
        <MoveDialog
          path={moveNode.path}
          label={`"${moveNode.label}"`}
          onClose={() => setMoveNode(null)}
          onMoved={(dest) => {
            setMoveNode(null);
            if (moveNode.kind === 'file') onOpen(dest);
          }}
        />
      )}
      {confirmDelete !== null && (
        <Dialog
          open
          onClose={() => setConfirmDelete(null)}
          title={`Move "${confirmDelete.label}" to Trash?`}
          width={420}
          primaryAction={{
            label: 'Move to Trash',
            onClick: () => void submitDelete(),
            disabled: submitting,
          }}
          secondaryAction={{ label: 'Cancel', onClick: () => setConfirmDelete(null) }}
        >
          <p className="m-0 text-[13px] text-[var(--n-600)]">
            {confirmDelete.kind === 'file'
              ? 'The page moves to the system Trash.'
              : 'The folder and everything inside it move to the system Trash.'}
          </p>
        </Dialog>
      )}
    </div>
  );
}
