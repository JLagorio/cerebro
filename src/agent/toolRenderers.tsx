import { useState, type ReactElement } from 'react';
import { ViewSuggestionCard } from './ViewSuggestionCard';
import { AiActionCard, toolIcon, toolPath, type GitHistory } from '@/agent/AiActionCard';
import {
  transcriptRows,
  type ToolGroupRow as GroupRow,
  type ToolRow,
  type ToolStatus,
} from '@/agent/transcriptRows';
import type { ToolCall } from '@/agent/types';
import { Icon } from '@/components/ui/Icon';
import { toolRenderer } from '@/engine/tools';
import type { Renderer } from '@/lib/policy/tools';

/**
 * Transcript rows drawn by the tool manifest's renderer (M56.8).
 *
 * `step` and `change` are the action card; `concept`, `handoff` and `commit`
 * are the rows a cerebro tool owns, each on its own door (tools.v1.json), and
 * each still an action card underneath, so every single row keeps
 * `data-testid="action-card"`, `data-tool` and `data-write`, and adds
 * `data-renderer` and `data-status`. A connector tool, or one the manifest
 * does not know, is a step. No tool is named here: the manifest says which
 * renderer a call takes (CV-04).
 */

/** What every renderer is handed. */
export interface RowProps {
  tool: ToolCall;
  status: ToolStatus;
  onOpenPath: (path: string) => void;
  onViewDiff?: (path: string) => void;
  history?: GitHistory;
  readOnly?: boolean;
}

/** One string field of a call's input, the whole one first. */
function inputField(tool: ToolCall, key: string): string | null {
  for (const text of [tool.payload?.input, tool.input]) {
    if (text == null) continue;
    try {
      const value = (JSON.parse(text) as Record<string, unknown>)[key];
      if (typeof value === 'string' && value !== '') return value;
    } catch {
      // A cut input is not JSON; the preview may still be.
    }
  }
  return null;
}

/** A call's output, the whole one first. */
function outputOf(tool: ToolCall): string | null {
  return tool.payload?.output ?? tool.output;
}

function StepRow(props: RowProps) {
  return <AiActionCard {...props} />;
}

function ViewRow(props: RowProps) {
  return props.status === 'done' && !props.tool.failed ? (
    <ViewSuggestionCard tool={props.tool} readOnly={props.readOnly} />
  ) : (
    <AiActionCard {...props} />
  );
}

/** A concept write: the card, and the way to the concept's review bar. */
function ConceptRow(props: RowProps) {
  const path = toolPath(props.tool.input);
  const reviewable = props.status === 'done' && path !== null;
  return (
    <AiActionCard {...props}>
      {reviewable && (
        <div className="px-2 pb-1.5">
          <button
            type="button"
            data-testid="action-open-review"
            onClick={() => props.onOpenPath(path)}
            className="rounded-md border border-cortex-200 bg-n-0 px-1.5 py-0.5 text-2xs text-cortex-700 hover:border-cortex-400"
          >
            Open to review
          </button>
        </div>
      )}
    </AiActionCard>
  );
}

/** A handoff: who the work went to, or that it could not go. Until it has
 * answered either way (running, interrupted, or held by a hook, M57.1), it is
 * the plain card, which says which. */
function HandoffRow(props: RowProps) {
  const agent = inputField(props.tool, 'agent');
  if (agent === null || (props.status !== 'done' && props.status !== 'failed')) {
    return <AiActionCard {...props} />;
  }
  if (props.status === 'failed') {
    const why = outputOf(props.tool);
    return (
      <AiActionCard {...props} summary={`Couldn't hand to ${agent}`}>
        {why !== null && (
          <div
            data-testid="action-handoff-refusal"
            className="px-2 pb-1.5 text-2xs text-danger-700"
          >
            {why}
          </div>
        )}
      </AiActionCard>
    );
  }
  return <AiActionCard {...props} summary={`Handed to ${agent}`} />;
}

/** What commit_proposals answered, when it is the JSON it writes. */
type CommitAnswer =
  | { kind: 'committed'; count: number; transition: string | null; kept: string[] }
  | { kind: 'refused'; code: string };

function commitAnswer(output: string | null): CommitAnswer | null {
  if (output === null) return null;
  try {
    const value = JSON.parse(output) as Record<string, unknown>;
    if (value.outcome === 'refused' && typeof value.code === 'string') {
      return { kind: 'refused', code: value.code };
    }
    if (Array.isArray(value.results)) {
      return {
        kind: 'committed',
        count: value.results.length,
        transition: typeof value.transition === 'string' ? value.transition : null,
        kept: Array.isArray(value.kept_files)
          ? value.kept_files.filter((f): f is string => typeof f === 'string')
          : [],
      };
    }
  } catch {
    // Not the answer's JSON: the card shows the raw output.
  }
  return null;
}

/** A commit of proposals: how many, and how, or the refusal's code. */
function CommitRow(props: RowProps) {
  const answer = props.status === 'done' ? commitAnswer(outputOf(props.tool)) : null;
  if (answer === null) return <AiActionCard {...props} />;
  if (answer.kind === 'refused') {
    return <AiActionCard {...props} summary={`Commit refused: ${answer.code}`} />;
  }
  const noun = answer.count === 1 ? 'proposal' : 'proposals';
  return (
    <AiActionCard {...props} summary={`Committed ${answer.count} ${noun}`}>
      {(answer.transition !== null || answer.kept.length > 0) && (
        <div data-testid="action-commit-detail" className="px-2 pb-1.5 text-2xs text-n-500">
          {answer.transition !== null && <span>{answer.transition.replace(/_/g, ' ')}</span>}
          {answer.kept.length > 0 && (
            <span className="[font-family:var(--font-mono)]">
              {answer.transition !== null && ' · '}
              {answer.kept.join(', ')}
            </span>
          )}
        </div>
      )}
    </AiActionCard>
  );
}

/** One renderer per value the manifest's vocabulary holds. */
export const RENDERERS: Record<Renderer, (props: RowProps) => ReactElement> = {
  step: StepRow,
  view: ViewRow,
  change: StepRow,
  concept: ConceptRow,
  handoff: HandoffRow,
  commit: CommitRow,
};

/** One call, drawn by its manifest renderer. */
export function ToolRowView({
  row,
  ...rest
}: Omit<RowProps, 'tool' | 'status'> & { row: ToolRow }) {
  const Render = RENDERERS[toolRenderer(row.tool.name)];
  return <Render tool={row.tool} status={row.status} {...rest} />;
}

/** Consecutive reads folded into one row, expanding to their cards. */
export function ToolGroupRow({
  group,
  ...rest
}: Omit<RowProps, 'tool' | 'status'> & { group: GroupRow }) {
  const [expanded, setExpanded] = useState(false);
  const first = group.members[0].tool;
  return (
    <div
      data-testid="action-group"
      data-count={group.members.length}
      data-status={group.running ? 'running' : 'done'}
      className="overflow-hidden rounded-lg border border-n-200 bg-n-25 text-xs"
    >
      <button
        type="button"
        data-testid="action-group-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 border-0 bg-transparent px-2 py-1.5 text-left"
      >
        <span className={group.running ? 'inline-flex animate-spin' : 'inline-flex'}>
          <Icon
            name={group.running ? 'loader' : 'circle-check'}
            size={11}
            color={group.running ? 'var(--n-400)' : 'var(--success-600)'}
          />
        </span>
        <Icon name={toolIcon(first.name)} size={11} color="var(--n-500)" />
        <span className="min-w-0 truncate font-medium text-n-700">{group.label}</span>
        <span className="flex-1" />
        <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={11} color="var(--n-400)" />
      </button>
      {/* The member cards stay mounted while folded, hidden: each is still
          the action card it was, for anything that counts them. */}
      <div hidden={!expanded} className="flex flex-col gap-1 border-t border-n-200 p-1">
        {group.members.map((member) => (
          <ToolRowView key={member.key} row={member} {...rest} />
        ))}
      </div>
    </div>
  );
}

/**
 * A message's calls as rows: reads folded, each other call by its renderer.
 * `streaming` is the message's, which decides once whether an unfinished
 * call is running or interrupted; `waitingToolId` is the call a card waits
 * on (M57.1), whose row reads waiting. The run detail (M56.9) renders a
 * transcript through this too, `readOnly`: a record of what a run did, with
 * no View diff and no word about reverting, since neither is offered there.
 */
export function TranscriptRows({
  tools,
  streaming,
  onOpenPath,
  onViewDiff,
  history,
  readOnly = false,
  waitingToolId = null,
}: {
  tools: ToolCall[];
  streaming: boolean;
  onOpenPath: (path: string) => void;
  onViewDiff?: (path: string) => void;
  history?: GitHistory;
  readOnly?: boolean;
  waitingToolId?: string | null;
}) {
  const rest = readOnly ? { onOpenPath, readOnly } : { onOpenPath, onViewDiff, history, readOnly };
  return (
    <div className="flex flex-col gap-1">
      {transcriptRows(tools, streaming, undefined, waitingToolId).map((row) =>
        row.kind === 'group' ? (
          <ToolGroupRow key={row.key} group={row} {...rest} />
        ) : (
          <ToolRowView key={row.key} row={row} {...rest} />
        ),
      )}
    </div>
  );
}
