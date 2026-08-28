import { useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Popover } from '@/components/ui/Popover';
import { stopAgent } from '@/agent/agentIpc';
import { placeLabel } from '@/engine/place';
import { describeRun, loadRunLog } from '@/engine/runLog';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * What the assistant is doing, and a way back to it (M17.7).
 *
 * This is the surface the reported bug asked for: *I start one task and then
 * go somewhere else.* Going somewhere else is fine now — the run survives it
 * (M17.2) and the thread stays where it was had (M17.5) — but nothing said so.
 * The status bar's "Assistant working" was a light with no switch behind it:
 * it could not say what was running, what it was about, or how to get back.
 *
 * Each row answers those three. Clicking a row goes to where the run belongs;
 * Stop kills that run and only that run, which is a sentence that could not be
 * written before runs had ids.
 */
export function RunList() {
  const runs = useUiStore((s) => s.runs);
  const setAiPanelOpen = useUiStore((s) => s.setAiPanelOpen);
  const navigate = useNavStore((s) => s.navigate);
  const entries = useVaultStore((s) => s.entries);
  const views = useVaultStore((s) => s.views);
  const collections = useVaultStore((s) => s.collections);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  // M17.15: what it did, under what it is doing. Read when the popover opens
  // rather than subscribed to — the log is append-only and nothing else in the
  // app writes it while this is on screen.
  const history = useMemo(() => (open ? loadRunLog().slice(0, 8) : []), [open]);

  // Nothing running and nothing ever run: the status bar stays quiet. A
  // segment that is always there is chrome, which the bar has a rule against.
  if (runs.length === 0 && loadRunLog().length === 0) return null;
  const lookup = { entries, views, collections };

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        data-testid="status-agent"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="inline-flex h-6 items-center gap-1.5 rounded-md border-0 bg-transparent px-1.5 text-xs hover:bg-n-100"
      >
        <Icon
          name="sparkles"
          size={11}
          color={runs.length === 0 ? 'var(--n-500)' : 'var(--cortex-600)'}
        />
        <span className={runs.length === 0 ? 'text-n-500' : 'text-cortex-600'}>
          {runs.length === 0
            ? 'Assistant idle'
            : runs.length === 1
              ? 'Assistant working'
              : `${runs.length} running`}
        </span>
      </button>
      {open && (
        <Popover
          anchorRef={anchorRef}
          onClose={() => setOpen(false)}
          ariaLabel="Running tasks"
          className="w-[280px] rounded-lg border border-n-200 bg-n-0 p-1 shadow-[var(--shadow-lg)]"
        >
          {runs.map((run) => (
            <div
              key={run.id}
              data-testid="run-row"
              className="group flex items-center gap-1 rounded-md px-2 py-1 hover:bg-n-50"
            >
              <Icon
                name={run.owner === 'chat' ? 'message-square' : 'sparkles'}
                size={11}
                color="var(--n-400)"
              />
              <button
                type="button"
                onClick={() => {
                  // Back to where it belongs: a chat run to its panel, a
                  // background job to the note it is reading. Both beat a
                  // spinner you cannot follow.
                  if (run.owner === 'chat') setAiPanelOpen(true);
                  else if (run.path !== null) navigate({ kind: 'doc', path: run.path });
                  if (run.place !== null) navigate(run.place);
                  setOpen(false);
                }}
                className="min-w-0 flex-1 border-0 bg-transparent p-0 text-left"
              >
                <span className="block truncate text-xs text-n-800">{run.label}</span>
                {run.place !== null && (
                  <span className="block truncate text-2xs text-n-400">
                    {placeLabel(run.place, lookup)}
                  </span>
                )}
              </button>
              <button
                type="button"
                data-testid="run-stop"
                aria-label={`Stop ${run.label}`}
                // Disabled for the moment before the child exists: there is
                // nothing to kill yet, and pretending otherwise would leave a
                // run the list thinks it stopped.
                disabled={run.run === null}
                onClick={() => {
                  if (run.run !== null) void stopAgent(run.run).catch(() => undefined);
                }}
                className="flex-none rounded border-0 bg-transparent p-0.5 text-n-400 hover:text-danger-500 disabled:opacity-40"
              >
                <Icon name="square" size={10} />
              </button>
            </div>
          ))}
          {history.length > 0 && (
            <>
              <div className="mt-1 border-t border-n-100 px-2 pb-0.5 pt-1.5 text-2xs font-medium uppercase tracking-wide text-n-400">
                Recently
              </div>
              {history.map((entry) => {
                // M33.7: an entry that knows its durable id can open the row
                // the database kept. One that does not is not broken — it is
                // a run from before this shipped, or one that happened where
                // no runtime database exists — and it says so rather than
                // offering a link that would land nowhere.
                const body = (
                  <>
                    <span className="block truncate text-xs text-n-700">{entry.label}</span>
                    {/* What it did, not what it said. The log is deliberately
                        not a transcript — see engine/runLog.ts. */}
                    <span
                      className={`block truncate text-2xs ${
                        entry.status === 'failed' ? 'text-danger-600' : 'text-n-400'
                      }`}
                    >
                      {describeRun(entry)} · {entry.trigger}
                      {entry.durableId === undefined && ' · this device only'}
                    </span>
                  </>
                );
                return (
                  <div
                    key={entry.id}
                    data-testid="run-log-row"
                    data-durable={entry.durableId ?? ''}
                    className="flex items-baseline gap-2 rounded-md px-2 py-1"
                  >
                    {entry.durableId === undefined ? (
                      <span className="min-w-0 flex-1">{body}</span>
                    ) : (
                      <button
                        type="button"
                        data-testid="run-log-link"
                        className="min-w-0 flex-1 border-0 bg-transparent p-0 text-left hover:underline"
                        onClick={() => {
                          navigate({
                            kind: 'knowledge',
                            nav: { tab: 'runs', run: entry.durableId },
                          });
                          setOpen(false);
                        }}
                      >
                        {body}
                      </button>
                    )}
                  </div>
                );
              })}
            </>
          )}
        </Popover>
      )}
    </>
  );
}
