import { useState, type ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { ToolCall } from '@/agent/types';
import { toolStatus, type ToolStatus } from '@/agent/transcriptRows';
import { showsAsChange, toolDisplay, toolIconName, toolRenderer } from '@/engine/tools';

/**
 * One thing the agent did (M9.5).
 *
 * Replaces the 20px chip. The agent has write access to this vault, and the
 * panel's job is to make that legible — `create note · knowledge/x.md` in a
 * pill tells you something happened, not what.
 *
 * Consecutive reads fold into one row before they reach a card
 * (transcriptRows.ts, M56.8); a WRITE card keeps its path visible while
 * collapsed, because that is the thing you might want to undo. Undo needs git
 * history: a turn that wrote becomes its own commit (M9.4), which View diff
 * reads. A vault with no git history has no revert for an agent's write, and
 * an expanded write card says so (M55.5) rather than leave it implied.
 */

/** What an expanded write card says when the vault keeps no git history. */
export const NO_REVERT =
  "Cerebro found no git history for this vault, so it can't revert this change.";

/** Whether the vault keeps git history, as the panel last read it. */
export type GitHistory = 'git' | 'none';

/** The vault's history from `useGit`'s state: undefined until git status has
 * been read, so a card never claims either way on a guess. */
export function historyOf(ready: boolean, isRepo: boolean): GitHistory | undefined {
  if (!ready) return undefined;
  return isRepo ? 'git' : 'none';
}

/** Compact attribution for text-only callers such as an interaction card.
 * Action cards render the same facts as a label and a server chip. */
export function toolLabel(name: string): string {
  const { label, server } = toolDisplay(name);
  return server === null ? label : `${server} · ${label}`;
}

/** What an unfinished call on a stopped turn says (M56.8): the turn ended
 * before its result came back, so it may have run all the same. A call a
 * hook deferred (M57.1) is never that: it did not run, and says why
 * (`DEFERRED`). */
export const INTERRUPTED = 'Interrupted, may have completed';

/** What a deferred call says, by its status (M57.1). */
export const DEFERRED: Readonly<Record<'waiting' | 'cancelled' | 'not_run' | 'paused', string>> = {
  waiting: 'Waiting for your answer',
  cancelled: 'Cancelled: it did not run',
  not_run: 'Not run: it waited for an answer that never came',
  paused: 'Paused by a hook outside Cerebro; your next message refuses it',
};

/** A whole payload's size, as the cut note names it. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const [value, unit] = bytes < 1024 * 1024 ? [bytes / 1024, 'KB'] : [bytes / 1024 / 1024, 'MB'];
  return `${Number(value.toFixed(1))} ${unit}`;
}

/** What a card shows of one part: the whole when a payload carried it, else
 * the preview; and the note when the 256 KiB cap cut even the whole. */
function partOf(
  preview: string | null,
  whole: string | undefined,
  truncated: boolean | undefined,
  bytes: number | undefined,
): { text: string | null; cut: string | null } {
  if (whole === undefined) return { text: preview, cut: null };
  return {
    text: whole,
    cut:
      truncated === true && bytes !== undefined
        ? `Showing the first 256 KB of ${formatSize(bytes)}.`
        : null,
  };
}

/** Manifest icons for local calls, a connector plug for foreign calls. */
export const toolIcon = toolIconName;

/** A write card: the manifest draws this call as a change or a concept, so
 * its path stays visible while collapsed and it offers a diff. */
export const isWrite = showsAsChange;

/** The path a tool touched, for the collapsed line. */
export function toolPath(input: string | null): string | null {
  if (input === null || input.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(input);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    for (const key of ['path', 'file_path', 'slug', 'to', 'folder', 'query', 'pattern']) {
      const value = record[key];
      if (typeof value === 'string' && value !== '') return value;
    }
    return null;
  } catch {
    return null;
  }
}
/** A successful checked change can land beside a taken name. Its structured
 * reply is authoritative for Open; a failed or pending call has no landing. */
function landedPath(tool: ToolCall): string | null {
  if (!tool.done || tool.failed || toolRenderer(tool.name) !== 'change') return null;
  try {
    const value: unknown = JSON.parse(tool.payload?.output ?? tool.output ?? 'null');
    if (
      typeof value === 'object' &&
      value !== null &&
      'path' in value &&
      typeof value.path === 'string' &&
      value.path !== ''
    )
      return value.path;
  } catch {
    /* Older text replies keep the input target. */
  }
  return null;
}

/** Pretty-print JSON input; fall back to the raw string when it isn't JSON. */
function formatInput(input: string): string {
  try {
    return JSON.stringify(JSON.parse(input), null, 2);
  } catch {
    return input;
  }
}

const STATUS_ICON: Record<ToolStatus, { name: string; color: string }> = {
  running: { name: 'loader', color: 'var(--n-400)' },
  done: { name: 'circle-check', color: 'var(--success-600)' },
  failed: { name: 'circle-x', color: 'var(--danger-500)' },
  interrupted: { name: 'circle-alert', color: 'var(--warn-600)' },
  waiting: { name: 'clock', color: 'var(--cortex-600)' },
  cancelled: { name: 'circle-x', color: 'var(--n-400)' },
  not_run: { name: 'circle-minus', color: 'var(--n-400)' },
  paused: { name: 'circle-alert', color: 'var(--warn-600)' },
};

export function AiActionCard({
  tool,
  onOpenPath,
  onViewDiff,
  history,
  status,
  summary,
  children,
}: {
  tool: ToolCall;
  onOpenPath: (path: string) => void;
  /** M9.4 present: review what this write changed. */
  onViewDiff?: (path: string) => void;
  /** Whether the vault keeps git history; unknown says nothing (M55.5). */
  history?: GitHistory;
  /** The row's status (M56.8, transcriptRows.ts). Absent, it is read off the
   * call alone, which cannot tell a running call from an interrupted one. */
  status?: ToolStatus;
  /** What the collapsed line says in place of the tool's name and path: a
   * renderer's own words ("Handed to release-scout"). */
  summary?: ReactNode;
  /** A renderer's own line under the card's, shown collapsed too. */
  children?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const display = toolDisplay(tool.name);
  const path = landedPath(tool) ?? toolPath(tool.input);
  const write = isWrite(tool.name);
  const state = status ?? toolStatus(tool, !tool.done);
  const payload = tool.payload;
  const input = partOf(tool.input, payload?.input, payload?.inputTruncated, payload?.inputBytes);
  const output = partOf(
    tool.output,
    payload?.output,
    payload?.outputTruncated,
    payload?.outputBytes,
  );
  const hasDetail = input.text !== null || output.text !== null;
  const noRevert = write && history === 'none' && !tool.failed;
  const icon = STATUS_ICON[state];

  return (
    <div
      data-testid="action-card"
      data-tool={tool.name}
      data-external={display.server !== null ? 'true' : undefined}
      data-server={display.server ?? undefined}
      data-write={write ? 'true' : 'false'}
      data-failed={tool.failed ? 'true' : 'false'}
      data-renderer={toolRenderer(tool.name)}
      data-status={state}
      className={[
        'overflow-hidden rounded-lg border text-xs',
        tool.failed
          ? 'border-danger-200 bg-danger-50'
          : write
            ? 'border-cortex-200 bg-cortex-50'
            : 'border-n-200 bg-n-25',
      ].join(' ')}
    >
      <button
        type="button"
        disabled={!hasDetail}
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 border-0 bg-transparent px-2 py-1.5 text-left disabled:cursor-default"
      >
        {/* M15: the loader actually turns. A static partial circle made a
            running tool indistinguishable from a hung one. M56.8: only while
            its turn runs; an unfinished call on a stopped turn reads
            interrupted and stops spinning, live after a stop and after a
            reload alike. */}
        <span className={state === 'running' ? 'inline-flex animate-spin' : 'inline-flex'}>
          <Icon name={icon.name} size={11} color={icon.color} />
        </span>
        <Icon name={toolIcon(tool.name)} size={11} color="var(--n-500)" />
        {summary !== undefined ? (
          <span className="min-w-0 truncate font-medium text-n-700">{summary}</span>
        ) : (
          <span className="flex-none font-medium text-n-700">{display.label}</span>
        )}
        {display.server !== null && (
          <span
            data-testid="action-server"
            title={`Ran on the ${display.server} connector, outside this vault`}
            className="min-w-0 truncate rounded-sm border border-n-200 px-1 text-2xs text-n-500"
          >
            {display.server}
          </span>
        )}
        {/* A write keeps its path visible collapsed — it is the thing you
            might want to undo. */}
        {summary === undefined && path !== null && (
          <span
            className={[
              'min-w-0 truncate [font-family:var(--font-mono)] text-2xs',
              write ? 'text-cortex-700' : 'text-n-400',
            ].join(' ')}
          >
            {path}
          </span>
        )}
        {state === 'interrupted' && (
          <span data-testid="action-interrupted" className="flex-none text-2xs text-n-500">
            {INTERRUPTED}
          </span>
        )}
        {(state === 'waiting' ||
          state === 'cancelled' ||
          state === 'not_run' ||
          state === 'paused') && (
          <span data-testid="action-deferred" className="flex-none text-2xs text-n-500">
            {DEFERRED[state]}
          </span>
        )}
        <span className="flex-1" />
        {hasDetail && (
          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={11} color="var(--n-400)" />
        )}
      </button>

      {children}

      {expanded && (
        <div className="border-t border-n-200 px-2 py-1.5">
          {input.text !== null && (
            <>
              <div className="pb-0.5 text-2xs font-semibold uppercase tracking-[0.06em] text-n-400">
                Input
              </div>
              <pre
                data-testid="action-input"
                className="m-0 max-h-[160px] overflow-auto whitespace-pre-wrap break-words [font-family:var(--font-mono)] text-2xs leading-[15px] text-n-600"
              >
                {formatInput(input.text)}
              </pre>
              {input.cut !== null && (
                <div data-testid="action-cut" className="pt-0.5 text-2xs text-n-500">
                  {input.cut}
                </div>
              )}
            </>
          )}
          {output.text !== null && (
            <>
              <div className="pb-0.5 pt-1.5 text-2xs font-semibold uppercase tracking-[0.06em] text-n-400">
                {tool.failed ? 'Error' : 'Result'}
              </div>
              <pre
                data-testid="action-output"
                className="m-0 max-h-[200px] overflow-auto whitespace-pre-wrap break-words [font-family:var(--font-mono)] text-2xs leading-[15px] text-n-700"
              >
                {output.text}
              </pre>
              {output.cut !== null && (
                <div data-testid="action-cut" className="pt-0.5 text-2xs text-n-500">
                  {output.cut}
                </div>
              )}
            </>
          )}
          {noRevert && (
            <div data-testid="action-no-revert" className="pt-1.5 text-2xs text-n-500">
              {NO_REVERT}
            </div>
          )}
          {path !== null && (
            <div className="flex gap-1.5 pt-1.5">
              <button
                type="button"
                onClick={() => onOpenPath(path)}
                className="rounded-md border border-n-200 bg-n-0 px-1.5 py-0.5 text-2xs text-n-600 hover:border-n-400"
              >
                Open
              </button>
              {/* Only for writes, and only when there is a history to diff
                  against — the payoff for having built M9.4 first. */}
              {write && onViewDiff !== undefined && history !== 'none' && (
                <button
                  type="button"
                  data-testid="action-view-diff"
                  onClick={() => onViewDiff(path)}
                  className="rounded-md border border-n-200 bg-n-0 px-1.5 py-0.5 text-2xs text-n-600 hover:border-n-400"
                >
                  View diff
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
