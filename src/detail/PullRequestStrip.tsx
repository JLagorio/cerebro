import { useCallback, useEffect, useMemo, useState } from 'react';
import { setMergedStatus } from '@/app/pullRequestActions';
import { Button } from '@/components/ui/Button';
import { splitFrontmatter } from '@/engine/frontmatter';
import { isKnowledgePath } from '@/engine/okf';
import {
  findPullRequestUrls,
  propertyPullRequestUrls,
  parsePullRequestUrl,
  statusSuggestion,
  type PrRead,
} from '@/engine/pullRequest';
import type { Entry, Schema } from '@/engine/types';
import { useVaultActionGuard } from '@/hooks/useVaultActionGuard';
import { readNoteSource } from '@/lib/ipc';
import { useVaultStore } from '@/stores/vaultStore';
import { PullRequestChip } from './PullRequestChip';
import { usePullRequest } from './usePullRequest';

export function PullRequestStrip({ entry, schema }: { entry: Entry; schema: Schema }) {
  const vault = useVaultStore((s) => s.vaultPath);
  if (vault === null || isKnowledgePath(entry.path)) return null;
  return (
    <Strip
      key={`${vault}\0${entry.path}\0${entry.hash}`}
      vault={vault}
      entry={entry}
      schema={schema}
    />
  );
}
/** Property chips render in their fields, but still count toward all-merged. */
function PropertyRead({
  url,
  onRead,
}: {
  url: string;
  onRead: (url: string, read: PrRead | null) => void;
}) {
  const { read } = usePullRequest(url);
  useEffect(() => onRead(url, read), [url, read, onRead]);
  return null;
}
function Strip({ vault, entry, schema }: { vault: string; entry: Entry; schema: Schema }) {
  const [source, setSource] = useState<{ content: string; hash: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);
  const [reads, setReads] = useState<Record<string, PrRead | null>>({});
  const [busy, setBusy] = useState(false);
  const capture = useVaultActionGuard(entry.path);
  useEffect(() => {
    const current = capture();
    let live = true;
    setSource(null);
    setFailed(false);
    void readNoteSource(vault, entry.path)
      .then((value) => {
        if (live && current()) setSource(value);
      })
      .catch(() => {
        if (live && current()) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [vault, entry.path, version, capture]);
  const properties = useMemo(() => propertyPullRequestUrls(entry), [entry]);
  const body = useMemo(
    () => (source === null ? [] : findPullRequestUrls(splitFrontmatter(source.content).body)),
    [source],
  );
  const all = useMemo(
    () => [...new Map([...properties, ...body].map((url) => [url.key, url])).values()],
    [properties, body],
  );
  const propertyKeys = new Set(properties.map((url) => url.key));
  const bodyOnly = body.filter((url) => !propertyKeys.has(url.key));
  // Bounded automatic reads. A page beyond the visible eight can never offer
  // an all-merged suggestion based on a partial set.
  const visible = bodyOnly.slice(0, 8);
  const hiddenPropertyReads = properties.slice(0, 8);
  const checked = [...hiddenPropertyReads, ...visible];
  const complete = checked.length === all.length;
  const onRead = useCallback(
    (url: string, read: PrRead | null) =>
      setReads((previous) =>
        previous[parsePullRequestUrl(url)!.key] === read
          ? previous
          : { ...previous, [parsePullRequestUrl(url)!.key]: read },
      ),
    [],
  );
  const outcomes = all.map((url) => reads[url.key] ?? null);
  const suggestion =
    source === null || !complete ? null : statusSuggestion(entry, schema, outcomes);
  const accept = async () => {
    if (source === null || suggestion === null || outcomes.some((read) => read === null)) return;
    const current = capture();
    setBusy(true);
    try {
      await setMergedStatus(entry.path, source.hash, outcomes as PrRead[], current);
    } finally {
      if (current()) setBusy(false);
    }
  };
  if (failed)
    return (
      <p data-testid="section-unavailable" className="my-2 text-xs text-n-500">
        Pull request links could not be read.{' '}
        <button type="button" className="text-cortex-600" onClick={() => setVersion((v) => v + 1)}>
          Try again
        </button>
      </p>
    );
  if (source === null || all.length === 0) return null;
  return (
    <div data-testid="pr-strip" className="my-2 flex flex-wrap items-center gap-2">
      {hiddenPropertyReads.map((url) => (
        <PropertyRead key={url.key} url={url.canonical} onRead={onRead} />
      ))}
      {visible.map((url) => (
        <PullRequestChip key={url.key} url={url.canonical} onRead={onRead} />
      ))}
      {bodyOnly.length > 8 && (
        <span className="text-xs text-n-400">and {bodyOnly.length - 8} more</span>
      )}
      {suggestion !== null && (
        <span title="its pull request merged">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void accept()}>
            Mark “{suggestion.label}”
          </Button>
        </span>
      )}
    </div>
  );
}
