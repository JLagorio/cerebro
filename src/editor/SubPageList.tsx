import { useContext, useMemo } from 'react';
import { useOpenPath } from '@/app/useOpenPath';
import { EntryIcon } from '@/components/PageIcon';
import { childPagesOf } from '@/engine/docPages';
import { useVaultStore } from '@/stores/vaultStore';
import { NotePathContext } from './notePath';

/**
 * The child-page list block's face (M55.13): the sub-pages of the page it
 * sits on, live from the vault store, each opening as a page.
 *
 * Read-only by design (M29.48): the list is derived, so there is nothing in it
 * to edit, and the block writes nothing but its empty fence. Its rows take
 * onClick and never onPointerDown (DOM trap 9: ProseMirror stops a pointer
 * press inside a block before React hears it).
 */
export function SubPageList() {
  const path = useContext(NotePathContext);
  const entries = useVaultStore((s) => s.entries);
  const open = useOpenPath();
  const children = useMemo(() => {
    const host = path === null ? undefined : entries.find((e) => e.path === path);
    return host === undefined ? [] : childPagesOf(host, entries);
  }, [path, entries]);

  return (
    <div
      data-testid="sub-page-list"
      contentEditable={false}
      className="my-1 w-full rounded-lg border border-n-200 bg-n-0 px-1.5 py-1"
    >
      {path === null ? (
        <p className="m-0 px-1.5 py-1 text-sm text-n-500">Sub-pages show on a saved page.</p>
      ) : children.length === 0 ? (
        <p className="m-0 px-1.5 py-1 text-sm text-n-500">
          No sub-pages yet — add one from the page menu.
        </p>
      ) : (
        <ul className="m-0 p-0">
          {children.map((child) => (
            <li key={child.path} className="list-none">
              <button
                type="button"
                data-testid="sub-page-row"
                onClick={() => open(child.path)}
                className="flex w-full min-w-0 items-center gap-1.5 rounded-md border-0 bg-transparent px-1.5 py-1 text-left text-sm text-n-800 hover:bg-n-50"
              >
                <EntryIcon
                  entry={child}
                  size={14}
                  fallback={{ name: 'file-text', color: 'var(--n-500)' }}
                />
                <span className="truncate underline decoration-n-300 underline-offset-2">
                  {child.title}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
