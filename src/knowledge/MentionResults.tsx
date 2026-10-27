import { useEffect, useLayoutEffect, useRef } from 'react';
import { useEntryState } from '@/app/useEntryState';
import { useNavStore, usePaneId } from '@/stores/navStore';
import { DISCOVERY_CHANGED } from './sourceDiscoveryState';
import { sourceVisitOrigin, useSourceNavigation } from '@/app/sourceOpen';
import type { Entry } from '@/engine/types';
import { isDocEntry } from '@/engine/typeCatalog';
import type { OccurrenceMode, OccurrencePage } from '@/engine/sourceOccurrences';
import { findSourceOccurrences } from '@/lib/ipc';
import { useVaultStore } from '@/stores/vaultStore';
import './mentionResults.css';

type Ready = Extract<OccurrencePage, { status: 'ready' }>;
interface Identity {
  vault: string | null;
  entries: Entry[];
  targetPath: string;
  mode: OccurrenceMode;
}
interface State {
  identity: Identity;
  status: 'idle' | 'loading' | 'ready' | 'changed' | 'unavailable';
  page?: Ready;
  partial?: boolean;
  reason?: string;
  request?: { visitId: string; navSeq: number };
}
const same = (a: Identity, b: Identity) =>
  a.vault === b.vault &&
  a.entries === b.entries &&
  a.targetPath === b.targetPath &&
  a.mode === b.mode;

/** One on-demand query owner. Old excerpts are removed before an invalidated
 * identity can paint, including earlier continuation pages. */
export function MentionResults({
  targetPath,
  mode,
  active = true,
}: {
  targetPath: string;
  mode: OccurrenceMode;
  active?: boolean;
}) {
  const vault = useVaultStore((store) => store.vaultPath);
  const entries = useVaultStore((store) => store.entries);
  const identity: Identity = { vault, entries, targetPath, mode };
  const pane = usePaneId();
  const navSeq = useNavStore((nav) => nav.navSeq);
  const discoveryKey = `source.discovery:${mode}:${targetPath}` as const;
  const [state, setState] = useEntryState<State>(discoveryKey, { identity, status: 'idle' });
  const generation = useRef(0);
  const autoStarted = useRef(false);
  const attached = useRef<{ pane: typeof pane; key: string } | null>(null);
  const ownedRequest = useRef<State['request']>(undefined);
  const { openSource } = useSourceNavigation();
  const stale = !same(state.identity, identity);
  const status = stale ? 'changed' : state.status;
  const page = !stale ? state.page : undefined;
  const current = useRef(identity);
  current.current = identity;

  useLayoutEffect(() => {
    const nav = useNavStore.getPaneState(pane);
    const interrupted =
      state.status === 'loading' &&
      state.request &&
      (state.request.navSeq !== nav.navSeq ||
        state.request.visitId !== nav.readEntryState('source.visitId'));
    if (!same(state.identity, current.current) || interrupted) {
      generation.current++;
      setState({
        identity: current.current,
        status: 'changed',
        reason: interrupted
          ? 'Search was interrupted. Refresh to search again.'
          : DISCOVERY_CHANGED,
      });
    }
  }, [
    vault,
    entries,
    targetPath,
    mode,
    state.identity,
    state.status,
    state.request,
    navSeq,
    pane,
    setState,
  ]);
  useEffect(() => {
    const owner = { pane, key: discoveryKey };
    const requestGeneration = generation;
    attached.current = owner;
    return () => {
      if (attached.current === owner) attached.current = null;
      const request = ownedRequest.current;
      // Effect replay reattaches synchronously. A real unmount immediately
      // blocks answers, then marks only this instance's unfinished request.
      queueMicrotask(() => {
        const live = attached.current;
        if (live?.pane === pane && live.key === discoveryKey) return;
        if (live === null) requestGeneration.current++;
        const nav = useNavStore.getPaneState(pane);
        const saved = nav.readEntryState<State>(discoveryKey);
        if (
          request &&
          saved?.status === 'loading' &&
          saved.request === request &&
          request.navSeq === nav.navSeq &&
          request.visitId === nav.readEntryState('source.visitId')
        ) {
          nav.setEntryState(discoveryKey, {
            identity: saved.identity,
            status: 'changed',
            reason: 'Search was interrupted. Refresh to search again.',
          });
        }
      });
    };
  }, [pane, discoveryKey]);

  const load = async (cursor: string | null = null) => {
    if (!active || !vault) return;
    const request = identity;
    const token = ++generation.current;
    const origin = sourceVisitOrigin(vault, pane);
    const owner = { visitId: origin.visitId, navSeq: useNavStore.getPaneState(pane).navSeq };
    ownedRequest.current = owner;
    const ownsVisit = () => {
      const nav = useNavStore.getPaneState(pane);
      return (
        attached.current?.pane === pane &&
        attached.current.key === discoveryKey &&
        nav.navSeq === owner.navSeq &&
        nav.readEntryState('source.visitId') === owner.visitId
      );
    };
    const previous = cursor && !stale ? state.page : undefined;
    setState({
      identity: request,
      status: 'loading',
      page: previous,
      partial: state.partial,
      request: owner,
    });
    try {
      const result = await findSourceOccurrences(vault, targetPath, mode, cursor);
      if (token !== generation.current || !same(request, current.current) || !ownsVisit()) return;
      if (result.status === 'changedSnapshot') {
        setState({ identity: request, status: 'changed', reason: result.reason });
        return;
      }
      if (previous && previous.snapshotId !== result.snapshotId) {
        setState({
          identity: request,
          status: 'changed',
          reason: 'Sources changed. Refresh to search again.',
        });
        return;
      }
      const rows = previous ? [...previous.rows, ...result.rows] : result.rows;
      const partial =
        !!(previous && state.partial) ||
        result.counts.cappedSources > 0 ||
        result.counts.unavailableSources > 0 ||
        result.counts.unsupportedSources > 0;
      setState({ identity: request, status: 'ready', page: { ...result, rows }, partial });
    } catch {
      if (token === generation.current && same(request, current.current) && ownsVisit())
        setState({ identity: request, status: 'unavailable' });
    }
  };
  useEffect(() => {
    if (active && mode === 'linked' && state.status === 'idle' && !stale && !autoStarted.current) {
      autoStarted.current = true;
      void load();
    }
  });

  const pages = page ? new Set(page.rows.map((row) => row.location.path)).size : 0;
  return (
    <div
      data-testid="source-occurrences"
      className="cb-source-occurrences"
      aria-busy={status === 'loading'}
    >
      {status === 'idle' && mode === 'mention' && (
        <>
          <p data-testid="source-occurrences-not-searched">Mentions have not been searched.</p>
          <button type="button" onClick={() => void load()}>
            Search mentions
          </button>
        </>
      )}
      {status === 'loading' && <p role="status">Searching sources…</p>}
      {status === 'changed' && (
        <p role="status">{state.reason ?? 'Sources changed. Refresh to search again.'}</p>
      )}
      {status === 'unavailable' && (
        <p data-testid="section-unavailable" role="status">
          Source discovery is unavailable.
        </p>
      )}
      {(status === 'changed' || status === 'unavailable') && (
        <button type="button" onClick={() => void load()}>
          Refresh
        </button>
      )}
      {page && (
        <>
          <p data-testid="source-occurrences-count">
            {page.rows.length} {page.rows.length === 1 ? 'occurrence' : 'occurrences'} on {pages}{' '}
            {pages === 1 ? 'page' : 'pages'}
          </p>
          <ul>
            {page.rows.map((row) => {
              const source = entries.find((entry) => entry.path === row.location.path);
              const title = source?.title ?? row.location.path;
              const target = entries.find((entry) => entry.path === row.targetPath);
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    data-testid="source-occurrence-row"
                    aria-label={`${title}: ${row.location.prefix}${row.location.quote}${row.location.suffix}`}
                    onClick={() =>
                      void openSource({
                        requestId: crypto.randomUUID(),
                        locator: row.location,
                        origin: sourceVisitOrigin(row.location.vaultId, pane),
                        intent: 'default',
                      })
                    }
                  >
                    <span className="cb-source-occurrences-title">
                      {title}
                      {row.via !== 'body' && ` · ${row.via}`}
                    </span>
                    <span>
                      {row.location.prefix}
                      <mark>{row.location.quote}</mark>
                      {row.location.suffix}
                    </span>
                  </button>
                  {mode === 'mention' &&
                    row.location.kind === 'body' &&
                    source &&
                    isDocEntry(source) &&
                    source.path.endsWith('.md') &&
                    source.authority === undefined &&
                    source.parseError === null &&
                    source.hash === row.location.sourceHash &&
                    target?.hash &&
                    target.authority === undefined &&
                    target.parseError === null && (
                      <button
                        type="button"
                        aria-label={`Link mention in ${title}: ${row.location.quote}`}
                        onClick={() => {
                          if (!active || !same(identity, current.current)) return;
                          void openSource({
                            requestId: crypto.randomUUID(),
                            locator: row.location,
                            origin: sourceVisitOrigin(row.location.vaultId, pane),
                            intent: 'default',
                            mentionLink: {
                              occurrenceId: row.id,
                              targetPath: row.targetPath,
                              targetHash: target.hash!,
                            },
                          });
                        }}
                      >
                        Link mention
                      </button>
                    )}
                </li>
              );
            })}
          </ul>
          {page.rows.length === 0 && !page.nextCursor && !state.partial && (
            <p data-testid="source-occurrences-empty">
              {mode === 'linked' ? 'No linked occurrences found.' : 'No unlinked mentions found.'}
            </p>
          )}
          {(page.nextCursor || state.partial) && (
            <p data-testid="source-occurrences-partial">
              Search is incomplete. Some sources remain unexamined or could not supply an exact
              occurrence.
            </p>
          )}
          {state.partial && (
            <p>
              Last page: {page.counts.cappedSources} capped, {page.counts.unavailableSources}{' '}
              unavailable, {page.counts.unsupportedSources} unsupported sources.
            </p>
          )}
          {page.nextCursor && (
            <button
              type="button"
              disabled={status === 'loading'}
              onClick={() => void load(page.nextCursor)}
            >
              Continue search
            </button>
          )}
        </>
      )}
    </div>
  );
}
