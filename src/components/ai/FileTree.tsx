// Ported from shadcn/ui at 25af02b, MIT, Copyright (c) 2023 shadcn; see THIRD_PARTY_NOTICES.md.
import { createContext, useContext, type ComponentProps, type ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import type {
  FileTreeFile as FileNode,
  FileTreeFolder as FolderNode,
  FileTreeNode,
} from '@/engine/ai/fileTree';
import { CHANGESET_WORDS, type ChangeKind } from '@/engine/changeset';
import { plural, vaultPathOf, type VaultPathProps } from './StepLine';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from './Trace';
import './trace-steps.css';
import './trace-results.css';

/**
 * The files a turn changed, as a folder tree (M91.9, shadcn's File Tree),
 * from engine/ai/fileTree.ts: folders that open and close, folders first,
 * and files, each saying how it changed in words — "added", "modified",
 * "deleted", "renamed" — and its lines, "+12 −3". A file git counted no lines
 * for reads "binary", or "not recorded" where the counts were not kept, and
 * never 0 (CV-05); a folder counts its files and sums only the lines git
 * counted.
 *
 * A file is a button that opens it in the app, through the caller, never an
 * href (CV-16): a deleted file, or a path outside the vault, is a line of
 * text. Its actions — View diff, Restore — sit beside the button, never in
 * it. Like shadcn's, it is a list of buttons, each a tab stop, not an ARIA
 * tree.
 */

/** What a file without line counts reads as: a changeset's binary file, or
 *  counts nobody kept. */
export type MissingCounts = 'binary' | 'not_recorded';

/** How a file changed, in words. */
export const FILE_CHANGE_WORDS: Readonly<Record<ChangeKind, string>> = {
  added: 'added',
  modified: 'modified',
  deleted: 'deleted',
  renamed: 'renamed',
};

/** Each change's file icon. */
export const FILE_CHANGE_ICONS: Readonly<Record<ChangeKind, string>> = {
  added: 'file-plus',
  modified: 'file-pen',
  deleted: 'file-minus',
  renamed: 'file-symlink',
};

/** The words for counts that were not kept. */
export const NOT_RECORDED = 'not recorded';

/** A file's lines: "+12 −3", or the words for counts git did not give. */
export function fileLineWords(
  file: Pick<FileNode, 'additions' | 'deletions'>,
  missing: MissingCounts = 'binary',
): string {
  if (file.additions === null || file.deletions === null) {
    return missing === 'binary' ? CHANGESET_WORDS.binary : NOT_RECORDED;
  }
  return `+${file.additions} −${file.deletions}`;
}

/** A folder's line: how many files, the lines git counted under it, and how
 *  many files it could not count. */
export function folderWords(folder: FolderNode, missing: MissingCounts = 'binary'): string {
  const words = [plural(folder.files, 'file', 'files')];
  if (folder.additions !== null && folder.deletions !== null) {
    words.push(`+${folder.additions} −${folder.deletions}`);
  }
  if (folder.uncounted > 0) {
    words.push(
      `${folder.uncounted} ${missing === 'binary' ? CHANGESET_WORDS.binary : NOT_RECORDED}`,
    );
  }
  return words.join(' · ');
}

interface FileTreeState extends VaultPathProps {
  missing: MissingCounts;
  defaultExpanded?: ReadonlySet<string>;
  selectedPath?: string;
  actions?: (file: FileNode) => ReactNode;
  detail?: (file: FileNode) => ReactNode;
  tabIndex?: number;
}

const FileTreeContext = createContext<FileTreeState>({ missing: 'binary' });

/** Buttons beside a file — View diff, Restore. */
export function FileTreeActions({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="file-tree-actions"
      {...props}
      className={['cb-ai-file-tree-actions', className].filter(Boolean).join(' ')}
    />
  );
}

/** One file: a button that opens it when it is a vault page that still
 *  exists, its actions beside it, and its caller's lines under it. */
export function FileTreeFile({ file }: { file: FileNode }) {
  const tree = useContext(FileTreeContext);
  const path =
    tree.onOpenPath === undefined || file.kind === 'deleted'
      ? null
      : vaultPathOf(file.path, tree.isVaultPath);
  const line = (
    <TraceLine>
      <TraceIcon>
        <Icon name={FILE_CHANGE_ICONS[file.kind]} size={16} />
      </TraceIcon>
      <TraceTitle>
        {path !== null && <span className="sr-only">Open </span>}
        {file.name}
      </TraceTitle>
      <TraceDescription>
        {FILE_CHANGE_WORDS[file.kind]} · {fileLineWords(file, tree.missing)}
      </TraceDescription>
    </TraceLine>
  );
  const actions = tree.actions?.(file);
  const detail = tree.detail?.(file);
  const shown = (node: ReactNode) => node !== undefined && node !== null && node !== false;
  return (
    <div
      data-slot="file-tree-file"
      data-path={file.path}
      data-kind={file.kind}
      className="cb-ai-file-tree-file"
    >
      <div className="cb-ai-file-tree-row">
        {path !== null && tree.onOpenPath !== undefined ? (
          <button
            type="button"
            title={file.path}
            aria-current={tree.selectedPath === file.path ? 'true' : undefined}
            tabIndex={tree.tabIndex}
            className="cb-ai-step-link cb-ai-file-tree-open"
            onClick={() => tree.onOpenPath?.(path)}
          >
            {line}
          </button>
        ) : (
          <span title={file.path} className="cb-ai-file-tree-name">
            {line}
          </span>
        )}
        {shown(actions) && <FileTreeActions>{actions}</FileTreeActions>}
      </div>
      {file.kind === 'renamed' && file.previousPath !== undefined && (
        <p data-slot="file-tree-moved" className="cb-ai-file-tree-note">
          from {file.previousPath}
        </p>
      )}
      {shown(detail) && <div className="cb-ai-file-tree-detail">{detail}</div>}
    </div>
  );
}

/** One folder: a line that opens onto what it holds, kept in the document
 *  while closed so each folder inside keeps its own state. */
export function FileTreeFolder({ folder }: { folder: FolderNode }) {
  const tree = useContext(FileTreeContext);
  return (
    <TraceCollapsible
      data-slot="file-tree-folder"
      data-path={folder.path}
      defaultOpen={tree.defaultExpanded === undefined || tree.defaultExpanded.has(folder.path)}
    >
      <TraceCollapsibleTrigger title={folder.path} tabIndex={tree.tabIndex}>
        <TraceLine>
          <TraceIcon>
            <Icon name="folder" size={16} />
          </TraceIcon>
          <TraceTitle>{folder.name}</TraceTitle>
          <TraceDescription>{folderWords(folder, tree.missing)}</TraceDescription>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent keepMounted>
        <FileTreeNodes nodes={folder.children} />
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

function FileTreeNodes({ nodes }: { nodes: readonly FileTreeNode[] }) {
  return (
    <Trace>
      {nodes.map((node) =>
        node.type === 'folder' ? (
          <FileTreeFolder key={`folder:${node.path}`} folder={node} />
        ) : (
          <FileTreeFile key={`file:${node.path}`} file={node} />
        ),
      )}
    </Trace>
  );
}

export type FileTreeProps = Omit<ComponentProps<'div'>, 'children'> &
  VaultPathProps & {
    /** The tree, as engine/ai/fileTree.ts's `buildFileTree` builds it. */
    tree: readonly FileTreeNode[];
    /** What a file without line counts reads: "binary" (a changeset's, the
     *  default), or "not recorded". */
    missingCounts?: MissingCounts;
    /** The folders open at first, by path; left out, every folder is. */
    defaultExpanded?: ReadonlySet<string>;
    /** The file shown beside the tree now, marked `aria-current`. */
    selectedPath?: string;
    /** Buttons beside each file: View diff, Restore. */
    actions?: (file: FileNode) => ReactNode;
    /** Lines under each file: who else edited it, its patch. */
    detail?: (file: FileNode) => ReactNode;
    /** An explicit tab stop for every row, a file's button and a folder's
     *  fold: WebKit leaves a native button without one out of the Tab order,
     *  so a caller that wants the rows reached says so. The tree itself
     *  takes none, and a row's actions are the caller's own buttons. */
    tabIndex?: number;
  };

/** The tree. With nothing in it, it draws nothing. */
export function FileTree({
  tree,
  missingCounts = 'binary',
  defaultExpanded,
  selectedPath,
  actions,
  detail,
  onOpenPath,
  isVaultPath,
  tabIndex,
  className,
  ...props
}: FileTreeProps) {
  if (tree.length === 0) return null;
  return (
    <FileTreeContext
      value={{
        missing: missingCounts,
        defaultExpanded,
        selectedPath,
        actions,
        detail,
        onOpenPath,
        isVaultPath,
        tabIndex,
      }}
    >
      <div
        data-slot="file-tree"
        {...props}
        className={['cb-ai-file-tree', className].filter(Boolean).join(' ')}
      >
        <FileTreeNodes nodes={tree} />
      </div>
    </FileTreeContext>
  );
}
