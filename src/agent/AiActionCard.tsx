import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { ToolCall } from '@/agent/types';
import { bareToolName, showsAsChange, toolIconName } from '@/engine/tools';

/**
 * One thing the agent did (M9.5).
 *
 * Replaces the 20px chip. The agent has write access to this vault, and the
 * panel's job is to make that legible — `create note · knowledge/x.md` in a
 * pill tells you something happened, not what.
 *
 * Read tools collapse to one line; WRITE tools keep their path visible while
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

/** Tool names arrive namespaced by the CLI (`mcp__cerebro__get_note`). */
export function toolLabel(name: string): string {
  const bare = bareToolName(name);
  // Native CLI tools are already capitalized and read fine as-is.
  if (/^[A-Z]/.test(bare)) return bare;
  return bare.replace(/_/g, ' ');
}

/** The icon the tool manifest gives a call, in either vocabulary the CLI
 * mixes in one transcript (M54.2); the wrench only for a tool it does not
 * know. */
export const toolIcon = toolIconName;

/** A write card: the manifest draws this call as a change, so its path stays
 * visible while collapsed and it offers a diff. */
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

/** Pretty-print JSON input; fall back to the raw string when it isn't JSON. */
function formatInput(input: string): string {
  try {
    return JSON.stringify(JSON.parse(input), null, 2);
  } catch {
    return input;
  }
}

export function AiActionCard({
  tool,
  onOpenPath,
  onViewDiff,
  history,
}: {
  tool: ToolCall;
  onOpenPath: (path: string) => void;
  /** M9.4 present: review what this write changed. */
  onViewDiff?: (path: string) => void;
  /** Whether the vault keeps git history; unknown says nothing (M55.5). */
  history?: GitHistory;
}) {
  const [expanded, setExpanded] = useState(false);
  const path = toolPath(tool.input);
  const write = isWrite(tool.name);
  const hasDetail = tool.input !== null || tool.output !== null;
  const noRevert = write && history === 'none' && !tool.failed;

  const statusIcon = !tool.done ? 'loader' : tool.failed ? 'circle-x' : 'circle-check';
  const statusColor = !tool.done
    ? 'var(--n-400)'
    : tool.failed
      ? 'var(--danger-500)'
      : 'var(--success-600)';

  return (
    <div
      data-testid="action-card"
      data-tool={tool.name}
      data-write={write ? 'true' : 'false'}
      data-failed={tool.failed ? 'true' : 'false'}
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
            running tool indistinguishable from a hung one. */}
        <span className={tool.done ? 'inline-flex' : 'inline-flex animate-spin'}>
          <Icon name={statusIcon} size={11} color={statusColor} />
        </span>
        <Icon name={toolIcon(tool.name)} size={11} color="var(--n-500)" />
        <span className="flex-none font-medium text-n-700">{toolLabel(tool.name)}</span>
        {/* A write keeps its path visible collapsed — it is the thing you
            might want to undo. */}
        {path !== null && (
          <span
            className={[
              'min-w-0 truncate [font-family:var(--font-mono)] text-2xs',
              write ? 'text-cortex-700' : 'text-n-400',
            ].join(' ')}
          >
            {path}
          </span>
        )}
        <span className="flex-1" />
        {hasDetail && (
          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={11} color="var(--n-400)" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-n-200 px-2 py-1.5">
          {tool.input !== null && (
            <>
              <div className="pb-0.5 text-2xs font-semibold uppercase tracking-[0.06em] text-n-400">
                Input
              </div>
              <pre className="m-0 max-h-[160px] overflow-auto whitespace-pre-wrap break-words [font-family:var(--font-mono)] text-2xs leading-[15px] text-n-600">
                {formatInput(tool.input)}
              </pre>
            </>
          )}
          {tool.output !== null && (
            <>
              <div className="pb-0.5 pt-1.5 text-2xs font-semibold uppercase tracking-[0.06em] text-n-400">
                {tool.failed ? 'Error' : 'Result'}
              </div>
              <pre className="m-0 max-h-[200px] overflow-auto whitespace-pre-wrap break-words [font-family:var(--font-mono)] text-2xs leading-[15px] text-n-700">
                {tool.output}
              </pre>
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
