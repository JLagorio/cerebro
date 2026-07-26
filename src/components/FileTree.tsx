import { useMemo, useState } from 'react';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import type { Entry } from '@/engine/types';
import { createFolder, deleteNote, renameNote } from '@/lib/ipc';
import { slugify } from '@/lib/slug';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

interface TreeNode {
  path: string;
  name: string;
  kind: 'folder' | 'file';
  children: TreeNode[];
}

const displayName = (filename: string) => filename.replace(/\.md$/, '');
const parentDir = (path: string) =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

function buildTree(
  root: string,
  entries: Entry[],
  folders: string[],
  hide: (path: string) => boolean,
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
      node = { path, name: path.split('/').pop() ?? path, kind: 'folder', children: [] };
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
    attach({ path: e.path, name: displayName(e.filename), kind: 'file', children: [] });
  }

  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort(
      (a, b) =>
        Number(a.kind === 'file') - Number(b.kind === 'file') || a.name.localeCompare(b.name),
    );
    for (const n of nodes) sortNodes(n.children);
  };
  sortNodes(roots);
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
  /** A file row (or freshly created page) was chosen. */
  onOpen: (path: string) => void;
}

/** Folder/note tree over the vault (M2 Task 10): create, rename, trash. */
export function FileTree({ root, hide = () => false, onOpen }: FileTreeProps) {
  const entries = useVaultStore((s) => s.entries);
  const folders = useVaultStore((s) => s.folders);
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const rescan = useVaultStore((s) => s.rescan);
  const createItem = useVaultStore((s) => s.createItem);
  const expanded = useUiStore((s) => s.expandedFolders);
  const toggleFolder = useUiStore((s) => s.toggleFolder);
  const toast = useUiStore((s) => s.toast);

  const tree = useMemo(
    () => buildTree(root, entries, folders, hide),
    [root, entries, folders, hide],
  );

  const [dialog, setDialog] = useState<TreeDialog | null>(null);
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<TreeNode | null>(null);
  // Task 14: right-click menu — node targets a row, node:null targets root.
  const [menu, setMenu] = useState<{ x: number; y: number; node: TreeNode | null } | null>(null);

  const openDialog = (d: TreeDialog) => {
    setDialog(d);
    setName(d.mode === 'rename' ? d.node.name : '');
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
        const path = await createItem({
          folder: dialog.dir,
          slug,
          frontmatter: {},
          body: `# ${trimmed}\n`,
        });
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
    const dir = node === null ? root : node.kind === 'folder' ? node.path : parentDir(node.path);
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
      {node.kind === 'folder' && (
        <>
          <IconButton
            icon="file-plus"
            label={`New page in ${node.name}`}
            size="sm"
            onClick={() => openDialog({ mode: 'new-page', dir: node.path })}
          />
          <IconButton
            icon="folder-plus"
            label={`New folder in ${node.name}`}
            size="sm"
            onClick={() => openDialog({ mode: 'new-folder', dir: node.path })}
          />
        </>
      )}
      <IconButton
        icon="pencil"
        label={`Rename ${node.name}`}
        size="sm"
        onClick={() => openDialog({ mode: 'rename', node })}
      />
      <IconButton
        icon="trash-2"
        label={`Delete ${node.name}`}
        size="sm"
        onClick={() => setConfirmDelete(node)}
      />
    </span>
  );

  const renderNodes = (nodes: TreeNode[], depth: number) =>
    nodes.map((node) => (
      <li key={node.path} className="list-none">
        <div
          className="group flex min-w-0 items-center gap-1 rounded-md pr-1 hover:bg-[var(--n-50)]"
          style={{ paddingLeft: depth * 16 }}
          onContextMenu={onRowContextMenu(node)}
        >
          {node.kind === 'folder' ? (
            <button
              type="button"
              data-testid="tree-folder"
              aria-expanded={expanded[node.path] === true}
              onClick={() => toggleFolder(node.path)}
              className="inline-flex min-w-0 flex-1 items-center gap-1.5 border-0 bg-transparent px-1 py-1 text-left text-[13px] text-[var(--n-800)]"
            >
              <Icon
                name={expanded[node.path] === true ? 'chevron-down' : 'chevron-right'}
                size={13}
                color="var(--n-400)"
              />
              <Icon name="folder" size={14} color="var(--n-500)" />
              <span className="truncate">{node.name}</span>
            </button>
          ) : (
            <button
              type="button"
              data-testid="tree-file"
              onClick={() => onOpen(node.path)}
              className="inline-flex min-w-0 flex-1 items-center gap-1.5 border-0 bg-transparent px-1 py-1 pl-[19px] text-left text-[13px] text-[var(--n-700)]"
            >
              <Icon name="file-text" size={14} color="var(--n-500)" />
              <span className="truncate">{node.name}</span>
            </button>
          )}
          {rowActions(node)}
        </div>
        {node.kind === 'folder' && expanded[node.path] === true && node.children.length > 0 && (
          <ul className="m-0 p-0">{renderNodes(node.children, depth + 1)}</ul>
        )}
        {node.kind === 'folder' && expanded[node.path] === true && node.children.length === 0 && (
          <p
            className="m-0 py-1 text-[12px] text-[var(--n-400)]"
            style={{ paddingLeft: depth * 16 + 40 }}
          >
            Empty folder
          </p>
        )}
      </li>
    ));

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
          className="inline-flex items-center gap-1 rounded-md border-0 bg-transparent px-1.5 py-1 text-[12px] text-[var(--n-500)] hover:bg-[var(--n-50)] hover:text-[var(--n-700)]"
        >
          <Icon name="file-plus" size={13} />
          New page
        </button>
        <button
          type="button"
          onClick={() => openDialog({ mode: 'new-folder', dir: root })}
          className="inline-flex items-center gap-1 rounded-md border-0 bg-transparent px-1.5 py-1 text-[12px] text-[var(--n-500)] hover:bg-[var(--n-50)] hover:text-[var(--n-700)]"
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
                : `Rename ${dialog.node.kind === 'file' ? 'page' : 'folder'}`
          }
          width={420}
          primaryAction={{
            label: dialog.mode === 'rename' ? 'Rename' : 'Create',
            onClick: () => void submitDialog(),
            disabled: name.trim() === '' || submitting,
          }}
          secondaryAction={{ label: 'Cancel', onClick: closeDialog }}
        >
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
        </Dialog>
      )}
      {confirmDelete !== null && (
        <Dialog
          open
          onClose={() => setConfirmDelete(null)}
          title={`Move "${confirmDelete.name}" to Trash?`}
          width={420}
          primaryAction={{
            label: 'Move to Trash',
            onClick: () => void submitDelete(),
            disabled: submitting,
          }}
          secondaryAction={{ label: 'Cancel', onClick: () => setConfirmDelete(null) }}
        >
          <p className="m-0 text-[13px] text-[var(--n-600)]">
            {confirmDelete.kind === 'folder'
              ? 'The folder and everything inside it move to the system Trash.'
              : 'The page moves to the system Trash.'}
          </p>
        </Dialog>
      )}
    </div>
  );
}
