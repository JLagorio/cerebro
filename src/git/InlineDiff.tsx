import { useEffect, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { DiffView } from '@/git/DiffView';
import * as git from '@/lib/gitIpc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * A diff shown in place of the editor (M9.7), with a way back.
 *
 * Diffs used to open in a Dialog. A diff is a way of looking at the note you
 * are already on — not a separate thing that interrupts it — and a modal
 * traps focus, blocks the note behind it, and makes "read this, then keep
 * editing" two dismissals instead of one link.
 *
 * Renders null when nothing is being diffed, so hosts can drop it in
 * unconditionally and let the store decide.
 */
export function InlineDiff({ path }: { path: string }) {
  const diffView = useUiStore((s) => s.diffView);
  const closeDiff = useUiStore((s) => s.closeDiff);
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const [diff, setDiff] = useState<string | null>(null);

  const active = diffView !== null && diffView.path === path;
  const commit = diffView?.commit ?? null;

  useEffect(() => {
    if (!active || vaultPath === null) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    const load =
      commit === null
        ? git.getFileDiff(vaultPath, path)
        : git.getFileDiffAtCommit(vaultPath, path, commit);
    void load
      .then((text) => {
        if (!cancelled) setDiff(text);
      })
      .catch(() => {
        if (!cancelled) setDiff('');
      });
    return () => {
      cancelled = true;
    };
  }, [active, vaultPath, path, commit]);

  // Escape returns to the editor, matching every other dismissable surface.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDiff();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, closeDiff]);

  if (!active) return null;

  return (
    <div data-testid="inline-diff" className="flex min-h-0 flex-1 flex-col">
      <div className="flex-none border-b border-n-100 bg-n-25 px-4 py-1.5">
        <button
          type="button"
          onClick={closeDiff}
          className="inline-flex items-center gap-1.5 rounded-md border-0 bg-transparent px-1 py-0.5 text-xs text-cortex-600 hover:bg-n-100"
        >
          <Icon name="arrow-left" size={12} />
          Return to the editor
        </button>
        {commit !== null && (
          <span className="ml-2 [font-family:var(--font-mono)] text-2xs text-n-400">
            {commit.slice(0, 7)}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {diff === null ? (
          <p className="m-0 text-[12.5px] text-n-400">Loading…</p>
        ) : (
          <DiffView
            diff={diff}
            emptyLabel={
              commit === null
                ? 'No uncommitted changes to this note.'
                : 'This commit did not change this note.'
            }
          />
        )}
      </div>
    </div>
  );
}
