import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { actorLabel } from '@/engine/authors';
import {
  alsoByWords,
  changesetHeadline,
  CHANGESET_WORDS,
  fileCounts,
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
 * Changeset Rust sends once the run's own commit has landed.
 *
 * "Changed N files · +a −b" reads git's own numstat; a binary file reads
 * "binary" and is never counted as 0 (CV-05). A file's patch loads when it is
 * first expanded, and not before, and stays loaded while the reply stands.
 * View diff opens the file at the run's commit, so it shows what the run did
 * even after the person's later edits; with no commit (a vault with no
 * history, a commit that failed) there is nothing to open and no button.
 */
export function TurnChangeset({
  changesets,
  onViewDiff,
  onOpenPath,
}: {
  changesets: readonly RunChangeset[];
  /** Open a file's diff at a commit; absent where diffs cannot be shown. */
  onViewDiff?: (path: string, commit: string) => void;
  onOpenPath?: (path: string) => void;
}) {
  return (
    <>
      {changesets.map((changeset, i) => (
        <OneChangeset
          key={`${changeset.run_id ?? 'none'}-${i}`}
          changeset={changeset}
          onViewDiff={onViewDiff}
          onOpenPath={onOpenPath}
        />
      ))}
    </>
  );
}

function OneChangeset({
  changeset,
  onViewDiff,
  onOpenPath,
}: {
  changeset: RunChangeset;
  onViewDiff?: (path: string, commit: string) => void;
  onOpenPath?: (path: string) => void;
}) {
  const entries = useVaultStore((s) => s.entries);
  const headline = changesetHeadline(changeset);
  const shell = 'shell_unrecorded' in changeset && changeset.shell_unrecorded;
  const keptOut = keptOutOfGitWords(changeset);
  if (headline === null && !shell && keptOut === null) return null;
  const commit = changeset.state === 'committed' ? changeset.commit : null;
  const label = (actor: string) => actorLabel(actor, entries).text;

  return (
    <div
      data-testid="turn-changeset"
      data-state={changeset.state}
      className="flex flex-col gap-1 rounded-lg border border-n-200 bg-n-25 px-2.5 py-1.5 text-xs text-n-700"
    >
      {headline !== null && (
        <div className="flex min-w-0 items-center gap-2">
          <Icon name="file-diff" size={12} color="var(--n-500)" />
          <span className="min-w-0 flex-1 truncate">{headline}</span>
          {commit !== null && (
            <span className="[font-family:var(--font-mono)] text-2xs text-n-400">
              {shortHash(commit)}
            </span>
          )}
          {commit !== null &&
            changeset.state === 'committed' &&
            changeset.files.length > 0 &&
            onViewDiff !== undefined && (
              <button
                type="button"
                data-testid="turn-changeset-view-diff"
                onClick={() => onViewDiff(changeset.files[0].path, commit)}
                className="rounded-md border border-n-200 bg-n-0 px-1.5 py-0.5 text-2xs text-cortex-600 hover:border-n-300"
              >
                {CHANGESET_WORDS.viewDiff}
              </button>
            )}
        </div>
      )}
      {changeset.state === 'committed' &&
        changeset.files.map((file) => (
          <CommittedFile
            key={file.path}
            file={file}
            commit={changeset.commit}
            also={alsoByWords(file.also_by, label)}
            onViewDiff={onViewDiff}
          />
        ))}
      {(changeset.state === 'not_a_repo' || changeset.state === 'unavailable') &&
        changeset.files.map((path) => (
          <div key={path} data-testid="turn-changeset-file" className="flex min-w-0 pl-5">
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
        <p className="m-0 pl-5 text-2xs text-n-500">{CHANGESET_WORDS.notARepo}</p>
      )}
      {keptOut !== null && (
        <p data-testid="turn-changeset-kept-out" className="m-0 pl-5 text-2xs text-n-500">
          {keptOut}
        </p>
      )}
      {shell && <p className="m-0 pl-5 text-2xs text-n-500">{CHANGESET_WORDS.shell}</p>}
    </div>
  );
}

/** One file of a run's commit: its counts, who else edited it, and its patch
 * once expanded. A binary file has no lines to expand. */
function CommittedFile({
  file,
  commit,
  also,
  onViewDiff,
}: {
  file: ChangedFile;
  commit: string;
  also: string | null;
  onViewDiff?: (path: string, commit: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Mounted on the first expand and kept, so the patch is read once.
  const [asked, setAsked] = useState(false);
  const binary = file.additions === null;
  const toggle = () => {
    setAsked(true);
    setOpen((was) => !was);
  };
  return (
    <div data-testid="turn-changeset-file" className="flex flex-col pl-5">
      <div className="flex min-w-0 items-center gap-2">
        {binary ? (
          <span className="min-w-0 flex-1 truncate">{file.path}</span>
        ) : (
          <button
            type="button"
            aria-expanded={open}
            onClick={toggle}
            className="flex min-w-0 flex-1 items-center gap-1 border-0 bg-transparent p-0 text-left text-xs text-n-700 hover:text-n-900"
          >
            <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} />
            <span className="min-w-0 truncate">{file.path}</span>
          </button>
        )}
        <span className="flex-none [font-family:var(--font-mono)] text-2xs text-n-500">
          {fileCounts(file)}
        </span>
        {onViewDiff !== undefined && (
          <button
            type="button"
            aria-label={`View diff of ${file.path}`}
            onClick={() => onViewDiff(file.path, commit)}
            className="inline-flex flex-none rounded-xs border-0 bg-transparent p-0.5 text-n-400 hover:text-n-800"
          >
            <Icon name="maximize-2" size={11} />
          </button>
        )}
      </div>
      {also !== null && <span className="pl-4 text-2xs text-n-500">{also}</span>}
      {asked && (
        <div hidden={!open} className="pt-1">
          <FilePatchView path={file.path} commit={commit} />
        </div>
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
