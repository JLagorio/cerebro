import { useState } from 'react';
import { FileTree } from '@/components/ai/FileTree';
import { TraceDescription, TraceIcon, TraceLine, TraceTitle } from '@/components/ai/Trace';
import { Unfold } from '@/agent/Unfold';
import { useArrival } from '@/components/ui/motion';
import { Icon } from '@/components/ui/Icon';
import { buildFileTree, fileChangeOf } from '@/engine/ai/fileTree';
import { actorLabel } from '@/engine/authors';
import {
  alsoByWords,
  changesetHeadline,
  CHANGESET_WORDS,
  keptOutOfGitWords,
  shortHash,
  type ChangedFile,
  type RunChangeset,
} from '@/engine/changeset';
import { DiffView } from '@/git/DiffView';
import { useFilePatch } from '@/git/useGit';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * What a turn changed (M58.3), under its reply: one footer per run, from the
 * Changeset Rust sends once the run's own commit has landed, its files drawn
 * as the AI elements' File Tree (M91.13).
 *
 * "Changed N files · +a −b" reads git's own numstat; a binary file reads
 * "binary" and is never counted as 0 (CV-05). Each file says how it changed
 * in words and opens its page; beside it, its patch unfolds in place,
 * loading when it is first asked for and not before, and staying loaded
 * while the reply stands, and View diff opens it at the run's commit, so it
 * shows what the run did even after the person's later edits, and where a
 * version can be restored (InlineDiff). With no commit (a vault with no
 * history, a commit that failed) there is nothing to open and no button.
 */
export function TurnChangeset({
  changesets,
  onViewDiff,
  onOpenPath,
  arrive = false,
}: {
  changesets: readonly RunChangeset[];
  /** Open a file's diff at a commit; absent where diffs cannot be shown. */
  onViewDiff?: (path: string, commit: string) => void;
  onOpenPath?: (path: string) => void;
  /** The conversation watched the run that made it (components/ui/motion.ts): a
   *  footer that lands after its reply is drawn comes in. */
  arrive?: boolean;
}) {
  return (
    <>
      {changesets.map((changeset, i) => (
        <OneChangeset
          key={`${changeset.run_id ?? 'none'}-${i}`}
          changeset={changeset}
          onViewDiff={onViewDiff}
          onOpenPath={onOpenPath}
          arrive={arrive}
        />
      ))}
    </>
  );
}

function OneChangeset({
  changeset,
  onViewDiff,
  onOpenPath,
  arrive,
}: {
  changeset: RunChangeset;
  onViewDiff?: (path: string, commit: string) => void;
  onOpenPath?: (path: string) => void;
  arrive: boolean;
}) {
  const entries = useVaultStore((s) => s.entries);
  const arrival = useArrival(arrive);
  // The files whose patch is open, and those ever asked for: a patch mounts
  // on its first unfold and is kept, so it is read once.
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [asked, setAsked] = useState<ReadonlySet<string>>(new Set());
  const headline = changesetHeadline(changeset);
  const shell = 'shell_unrecorded' in changeset && changeset.shell_unrecorded;
  const keptOut = keptOutOfGitWords(changeset);
  if (headline === null && !shell && keptOut === null) return null;
  const commit = changeset.state === 'committed' ? changeset.commit : null;
  const label = (actor: string) => actorLabel(actor, entries).text;
  const toggle = (path: string) => {
    setAsked((was) => new Set(was).add(path));
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  };

  return (
    <div
      data-testid="turn-changeset"
      data-state={changeset.state}
      className="cb-turn-changeset flex flex-col gap-1.5"
      {...arrival}
    >
      {headline !== null && (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <TraceLine>
            <TraceIcon>
              <Icon name="file-diff" size={16} />
            </TraceIcon>
            <TraceTitle>{headline}</TraceTitle>
            {commit !== null && (
              <TraceDescription className="[font-family:var(--font-mono)]">
                {shortHash(commit)}
              </TraceDescription>
            )}
          </TraceLine>
          {commit !== null &&
            changeset.state === 'committed' &&
            changeset.files.length > 0 &&
            onViewDiff !== undefined && (
              <button
                type="button"
                data-testid="turn-changeset-view-diff"
                onClick={() => onViewDiff(changeset.files[0].path, commit)}
                className="motion-hover rounded-md border border-n-200 bg-n-0 px-1.5 py-0.5 text-2xs text-cortex-600 hover:border-n-300"
              >
                {CHANGESET_WORDS.viewDiff}
              </button>
            )}
        </div>
      )}
      {changeset.state === 'committed' && (
        <FileTree
          tree={buildFileTree(changeset.files.map(fileChangeOf))}
          onOpenPath={onOpenPath}
          actions={(file) => {
            const changed = changeset.files.find((f) => f.path === file.path);
            return changed === undefined ? null : (
              <FileActions
                file={changed}
                open={open.has(file.path)}
                onToggle={() => toggle(file.path)}
                onViewDiff={
                  onViewDiff === undefined
                    ? undefined
                    : () => onViewDiff(file.path, changeset.commit)
                }
              />
            );
          }}
          detail={(file) => {
            const changed = changeset.files.find((f) => f.path === file.path);
            return changed === undefined ? null : (
              <CommittedFile
                file={changed}
                commit={changeset.commit}
                also={alsoByWords(changed.also_by, label)}
                asked={asked.has(file.path)}
                open={open.has(file.path)}
              />
            );
          }}
        />
      )}
      {(changeset.state === 'not_a_repo' || changeset.state === 'unavailable') &&
        changeset.files.map((path) => (
          <div key={path} data-testid="turn-changeset-file" className="flex min-w-0 pl-6">
            <button
              type="button"
              onClick={() => onOpenPath?.(path)}
              className="min-w-0 truncate border-0 bg-transparent p-0 text-left text-xs text-n-700 hover:text-n-900"
            >
              {path}
            </button>
          </div>
        ))}
      {changeset.state === 'not_a_repo' && (
        <p className="m-0 pl-6 text-2xs text-n-500">{CHANGESET_WORDS.notARepo}</p>
      )}
      {keptOut !== null && (
        <p data-testid="turn-changeset-kept-out" className="m-0 pl-6 text-2xs text-n-500">
          {keptOut}
        </p>
      )}
      {shell && <p className="m-0 pl-6 text-2xs text-n-500">{CHANGESET_WORDS.shell}</p>}
    </div>
  );
}

/** Beside a committed file: its patch's toggle (a binary file has no lines
 * to unfold) and View diff at the run's commit. */
function FileActions({
  file,
  open,
  onToggle,
  onViewDiff,
}: {
  file: ChangedFile;
  open: boolean;
  onToggle: () => void;
  onViewDiff?: () => void;
}) {
  const binary = file.additions === null;
  return (
    <>
      {!binary && (
        <button
          type="button"
          aria-expanded={open}
          aria-label={`Show the changes to ${file.path}`}
          onClick={onToggle}
          className="motion-hover inline-flex flex-none rounded-xs border-0 bg-transparent p-0.5 text-n-400 hover:text-n-800"
        >
          <Icon name="chevron-right" size={12} className="cb-chat-chevron" />
        </button>
      )}
      {onViewDiff !== undefined && (
        <button
          type="button"
          aria-label={`View diff of ${file.path}`}
          onClick={onViewDiff}
          className="motion-hover inline-flex flex-none rounded-xs border-0 bg-transparent p-0.5 text-n-400 hover:text-n-800"
        >
          <Icon name="maximize-2" size={12} />
        </button>
      )}
    </>
  );
}

/** Under a committed file: who else edited it, and its patch once asked
 * for. */
function CommittedFile({
  file,
  commit,
  also,
  asked,
  open,
}: {
  file: ChangedFile;
  commit: string;
  also: string | null;
  asked: boolean;
  open: boolean;
}) {
  return (
    <div data-testid="turn-changeset-file" data-path={file.path} className="flex flex-col">
      {also !== null && <span className="text-2xs text-n-500">{also}</span>}
      {asked && (
        <Unfold open={open}>
          <div hidden={!open} className="cb-chat-reveal pt-1">
            <FilePatchView path={file.path} commit={commit} />
          </div>
        </Unfold>
      )}
    </div>
  );
}

function FilePatchView({ path, commit }: { path: string; commit: string }) {
  const read = useFilePatch(path, commit);
  if (read.kind === 'loading') return <p className="m-0 text-2xs text-n-400">Loading…</p>;
  if (read.kind === 'unavailable') {
    return (
      <p data-testid="section-unavailable" className="m-0 text-2xs text-n-500">
        {CHANGESET_WORDS.patchUnavailable}
      </p>
    );
  }
  return (
    <div data-testid="turn-changeset-patch" className="flex flex-col gap-1">
      {read.data.binary ? (
        <p className="m-0 text-2xs text-n-500">{CHANGESET_WORDS.binary}</p>
      ) : (
        <DiffView diff={read.data.text} />
      )}
      {read.data.truncated && (
        <p className="m-0 text-2xs text-n-500">{CHANGESET_WORDS.truncated}</p>
      )}
    </div>
  );
}
