import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { hasLayers } from '@/components/ui/layers';
import { humanize } from '@/engine/frontmatter';
import { restoreBlock, type FileAt, type FileCommit } from '@/engine/git';
import { CommitAuthor } from '@/git/CommitAuthor';
import { DiffView } from '@/git/DiffView';
import { relativeDate } from '@/git/GitHistoryPanel';
import { ProseDiffView } from '@/git/ProseDiffView';
import {
  restoreVersion,
  useCommitRuns,
  useFileHistory,
  useFileVersions,
  type GitRead,
} from '@/git/useGit';
import { VersionPreview } from '@/git/VersionPreview';
import * as git from '@/lib/gitIpc';
import { sha256Hex } from '@/lib/sha256';
import { useUiStore, type DiffReview } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/** What a version that could not be read says, never "did not change". */
export const VERSION_UNREADABLE = 'This version could not be read.';

type LensTab = 'changes' | 'version' | 'lines';

const TABS: { id: LensTab; label: string }[] = [
  { id: 'changes', label: 'Changes' },
  { id: 'version', label: 'This version' },
  { id: 'lines', label: 'Lines' },
];

/** A read run in an effect and kept with the request it answers. */
type Loaded = { kind: 'loading' } | { kind: 'unavailable' } | { kind: 'ready'; text: string };

/** One diff read, re-asked when its inputs change; a failure is unavailable. */
function useDiffText(load: (() => Promise<string>) | null): Loaded {
  const [answer, setAnswer] = useState<{ load: () => Promise<string>; read: Loaded } | null>(null);
  useEffect(() => {
    if (load === null) return;
    let live = true;
    new Promise<string>((resolve) => resolve(load())).then(
      (text) => live && setAnswer({ load, read: { kind: 'ready', text } }),
      () => live && setAnswer({ load, read: { kind: 'unavailable' } }),
    );
    return () => {
      live = false;
    };
  }, [load]);
  return load !== null && answer?.load === load ? answer.read : { kind: 'loading' };
}

function Unavailable({ children }: { children: string }) {
  return (
    <p data-testid="section-unavailable" className="m-0 text-sm text-n-500">
      {children}
    </p>
  );
}

/** The page's uncommitted changes, as lines (M9.7's diff). */
function WorkingTree({ path }: { path: string }) {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const load = useMemo(
    () => (vaultPath === null ? null : () => git.getFileDiff(vaultPath, path)),
    [vaultPath, path],
  );
  const diff = useDiffText(load);
  if (vaultPath === null || diff.kind === 'unavailable') {
    return <Unavailable>This page's changes could not be read.</Unavailable>;
  }
  if (diff.kind === 'loading') return <p className="m-0 text-sm text-n-400">Loading…</p>;
  return <DiffView diff={diff.text} emptyLabel="No uncommitted changes to this note." />;
}

const textOf = (at: FileAt | null): string | null => (at?.kind === 'text' ? at.text : null);

/** A side that is there but cannot read as prose: binary or too large. */
const unreadable = (at: FileAt | null): boolean =>
  at?.kind === 'binary' || at?.kind === 'too_large';

/** One version, three ways, and Restore. Opened from a turn (`review`), it
 * starts on Lines, where notes for the agent go (M58.5). */
function VersionLens({
  path,
  commit,
  review,
}: {
  path: string;
  commit: string;
  review: DiffReview | null;
}) {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const entryHash = useVaultStore((s) => s.entries.find((e) => e.path === path)?.hash ?? null);
  const closeDiff = useUiStore((s) => s.closeDiff);
  const history = useFileHistory(path);
  const row: FileCommit | null =
    history.kind === 'ready' ? (history.data.find((c) => c.hash === commit) ?? null) : null;
  const versions = useFileVersions(row);
  const queries = useMemo(
    () => (row === null ? [] : [{ hash: row.hash, path: row.pathAt, since: row.previousAt }]),
    [row],
  );
  const runs = useCommitRuns(queries);
  const [tab, setTab] = useState<LensTab>(review === null ? 'changes' : 'lines');
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const linesLoad = useMemo(
    () =>
      vaultPath === null || tab !== 'lines'
        ? null
        : () =>
            git.getFileDiffAtCommit(
              vaultPath,
              row?.pathAt ?? path,
              commit,
              row?.previousPath ?? null,
            ),
    [vaultPath, tab, row, path, commit],
  );
  const lines = useDiffText(linesLoad);

  // The row could not be found, or its versions not read: said, never empty.
  const lost = history.kind === 'unavailable' || (history.kind === 'ready' && row === null);
  const read: GitRead<{ before: FileAt | null; after: FileAt | null }> = lost
    ? { kind: 'unavailable' }
    : versions;
  const after = read.kind === 'ready' ? read.data.after : null;
  const afterText = textOf(after);
  const current = afterText !== null && entryHash !== null && sha256Hex(afterText) === entryHash;
  const blocked = row === null ? VERSION_UNREADABLE : restoreBlock(path, row, after);
  const offerRestore =
    vaultPath !== null && read.kind === 'ready' && blocked === null && afterText !== null;
  const title = humanize(path.split('/').pop()?.replace(/\.md$/, '') ?? path);

  const confirm = async () => {
    if (vaultPath === null || restoring) return;
    setRestoring(true);
    const restored = await restoreVersion(vaultPath, path, commit, title);
    setRestoring(false);
    setConfirming(false);
    if (restored) closeDiff();
  };

  return (
    <div data-testid="version-lens" className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none flex-wrap items-center gap-x-2 gap-y-1 border-b border-n-100 px-4 py-1.5">
        <div role="tablist" aria-label="Version" className="flex items-center gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              data-testid={`version-tab-${t.id}`}
              onClick={() => setTab(t.id)}
              className={[
                'rounded-md border-0 px-2.5 py-1 text-xs',
                tab === t.id
                  ? 'bg-n-100 font-medium text-n-900'
                  : 'bg-transparent text-n-500 hover:bg-n-50 hover:text-n-800',
              ].join(' ')}
            >
              {t.label}
            </button>
          ))}
        </div>
        <span className="ml-auto" />
        {offerRestore && current && (
          <span data-testid="version-current" className="text-2xs text-n-500">
            This is the current version
          </span>
        )}
        {offerRestore && !current && (
          <Button size="sm" testId="version-restore" onClick={() => setConfirming(true)}>
            Restore
          </Button>
        )}
      </div>
      {row !== null && (
        <div className="flex flex-none flex-wrap items-center gap-x-1 px-4 pt-2 text-2xs text-n-400">
          <span className="text-xs text-n-700">{row.message}</span>
          <span aria-hidden>·</span>
          <CommitAuthor commit={row} runs={runs} />
          {runs.kind !== 'loading' && <span aria-hidden>·</span>}
          <span>{relativeDate(row.date)}</span>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {tab === 'lines' &&
          (lines.kind === 'unavailable' ? (
            <Unavailable>{VERSION_UNREADABLE}</Unavailable>
          ) : lines.kind === 'loading' ? (
            <p className="m-0 text-sm text-n-400">Loading…</p>
          ) : (
            <DiffView
              diff={lines.text}
              emptyLabel="This version changed no lines of this page."
              notes={
                review === null || vaultPath === null
                  ? undefined
                  : {
                      vault: vaultPath,
                      conversationId: review.conversationId,
                      runId: review.runId,
                      commit,
                      path: row?.pathAt ?? path,
                    }
              }
            />
          ))}
        {tab === 'changes' && review !== null && (
          <p data-testid="lens-notes-hint" className="m-0 mb-3 text-2xs text-n-500">
            To leave a note for the agent, open Lines.
          </p>
        )}
        {tab !== 'lines' && read.kind === 'unavailable' && (
          <Unavailable>{VERSION_UNREADABLE}</Unavailable>
        )}
        {tab === 'changes' &&
          read.kind === 'ready' &&
          (unreadable(read.data.before) || unreadable(read.data.after) ? (
            <p data-testid="prose-summary" className="m-0 text-sm text-n-600">
              This version can't be read as prose. Open Lines to see it.
            </p>
          ) : (
            <ProseDiffView
              before={textOf(read.data.before)}
              after={afterText}
              previousPath={row?.previousPath ?? null}
            />
          ))}
        {tab === 'version' &&
          read.kind === 'ready' &&
          (afterText !== null ? (
            <VersionPreview commit={commit} text={afterText} />
          ) : (
            <p className="m-0 text-sm text-n-500">
              {after?.kind === 'too_large'
                ? 'This version is too large to show here.'
                : after?.kind === 'binary'
                  ? 'This version is not text, so it is not shown here.'
                  : 'This version removed the page.'}
            </p>
          ))}
      </div>
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Restore this version?"
        width={440}
      >
        <p className="m-0">
          The page becomes what it was {row === null ? 'then' : relativeDate(row.date)}. What it
          holds now stays in History.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            testId="restore-confirm"
            disabled={restoring}
            onClick={() => void confirm()}
          >
            Restore
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

/**
 * A page's diff, shown in place of the editor (M9.7), with a way back; and
 * since M58.4, a version from its history opens here as the version lens.
 *
 * Diffs used to open in a Dialog. A diff is a way of looking at the page you
 * are already on, not a separate thing that interrupts it, and a modal traps
 * focus, blocks the page behind it, and makes "read this, then keep
 * editing" two dismissals instead of one link.
 *
 * With no commit it is the page's uncommitted changes. With one it is that
 * version three ways: Changes (as prose, `ProseDiffView`), This version (the
 * page as it was, `VersionPreview`), and Lines (the raw diff, a rename read
 * as one); plus Restore, behind a confirm, where `restoreBlock` allows it and
 * the version is not the page as it stands. A turn's diff, opened from the
 * assistant panel with a `review`, starts on Lines and takes notes there
 * that go back to the agent (M58.5). A read that failed says so,
 * never that nothing changed (CV-05). Escape returns to the editor unless a
 * layer above the lens (the confirm, a popover) has the key.
 *
 * Renders null when nothing is being diffed, so hosts can drop it in
 * unconditionally and let the store decide.
 */
export function InlineDiff({ path }: { path: string }) {
  const diffView = useUiStore((s) => s.diffView);
  const closeDiff = useUiStore((s) => s.closeDiff);
  const active = diffView !== null && diffView.path === path;
  const commit = diffView?.commit ?? null;
  const review = diffView?.review ?? null;

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !hasLayers()) closeDiff();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, closeDiff]);

  if (!active) return null;

  return (
    <div data-testid="inline-diff" className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-center gap-2 border-b border-n-100 bg-n-25 px-4 py-1.5">
        <button
          type="button"
          onClick={closeDiff}
          className="inline-flex items-center gap-1.5 rounded-md border-0 bg-transparent px-1 py-0.5 text-xs text-cortex-600 hover:bg-n-100"
        >
          <Icon name="arrow-left" size={12} />
          Return to the editor
        </button>
        {commit !== null && (
          <span className="[font-family:var(--font-mono)] text-2xs text-n-400">
            {commit.slice(0, 7)}
          </span>
        )}
      </div>
      {commit === null ? (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <WorkingTree path={path} />
        </div>
      ) : (
        <VersionLens
          key={review === null ? commit : `${commit}:${review.conversationId}`}
          path={path}
          commit={commit}
          review={review}
        />
      )}
    </div>
  );
}
