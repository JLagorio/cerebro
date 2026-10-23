import { Children, Fragment, isValidElement, useState, type ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import { originOf } from '@/engine/ai/stackFrames';
import type { StepStatus } from '@/engine/ai/types';
import type { CollapsibleOpenProps } from './Collapsible';
import { TraceDescription, TraceIcon, TraceLine, TraceTitle, type TraceStatus } from './Trace';
import './trace-steps.css';

/**
 * The line every step of a trace draws (M91.9): a tool call, a folded group,
 * a subagent, a command. A step is in one of the transcript's eight states,
 * or refused, and says which in words as well as in ink (§3.3): the title's
 * own tense for work under way, done, failed or denied — "Running git
 * status", "Ran git status", "Failed to …", "Denied …" — and, for work a
 * stopped turn or a hook left unfinished, the transcript's own sentences,
 * which are also drawn under the title, since they are what the reader
 * needs to know.
 */

/** A step's state: the transcript's statuses, and a call a person or a rule
 *  refused. */
export type StepState = StepStatus | 'denied';

/**
 * The words each state is said in. Work under way, failed or refused is said
 * by its title in the right tense, so these are read only when the title does
 * not start with them; done work's past tense needs none. The last five are
 * the transcript's existing sentences (AiActionCard's `INTERRUPTED` and
 * `DEFERRED`): a call on a stopped turn may have run all the same, and a call
 * a hook deferred did not.
 */
export const STEP_STATUS_WORDS: Readonly<Record<StepState, string | null>> = {
  running: 'Running',
  done: null,
  failed: 'Failed',
  denied: 'Denied',
  interrupted: 'Interrupted, may have completed',
  waiting: 'Waiting for your answer',
  cancelled: 'Cancelled: it did not run',
  not_run: 'Not run: it waited for an answer that never came',
  paused: 'Paused by a hook outside Cerebro; your next message refuses it',
};

/** The states whose words are drawn under the title as well as read. */
const NOTED: ReadonlySet<StepState> = new Set([
  'interrupted',
  'waiting',
  'cancelled',
  'not_run',
  'paused',
]);

/** Each state's own icon, for a step that has no icon of its own. */
export const STEP_STATUS_ICONS: Readonly<Record<StepState, string>> = {
  running: 'loader-circle',
  done: 'circle-check',
  failed: 'circle-x',
  denied: 'ban',
  interrupted: 'circle-alert',
  waiting: 'clock',
  cancelled: 'circle-x',
  not_run: 'circle-minus',
  paused: 'circle-pause',
};

/** How a state draws on a TraceLine: under way, failed, or not started (a
 *  call that waits, or never ran). An interrupted call may have completed,
 *  and a refused one is done with, so both are drawn as done work is. */
export function stepTraceStatus(state: StepState): TraceStatus | undefined {
  switch (state) {
    case 'running':
      return 'running';
    case 'failed':
      return 'error';
    case 'waiting':
    case 'cancelled':
    case 'not_run':
    case 'paused':
      return 'pending';
    default:
      return undefined;
  }
}

/** The text a title starts with: a string, or the first child of a list or a
 *  fragment that is one ("Failed to read <TaskItemFile>…"). Anything else —
 *  an element of its own — starts with no text this can read. */
function leadingText(title: ReactNode): string | null {
  if (typeof title === 'string' || typeof title === 'number') return String(title);
  if (Array.isArray(title)) {
    const first = (title as ReactNode[]).find(
      (child) => child !== null && child !== undefined && child !== false && child !== '',
    );
    return first === undefined ? null : leadingText(first);
  }
  if (isValidElement<{ children?: ReactNode }>(title) && title.type === Fragment) {
    return leadingText(title.props.children);
  }
  return null;
}

/**
 * The words a step's line speaks before its title, or null for none. The
 * caller's `statusText` wins — its own words, or null when its title already
 * says the state; left out, the state's own words, unless the title's text
 * already starts with them ("Failed to read notes.md").
 */
export function stepWords(
  state: StepState,
  statusText: string | null | undefined,
  title: ReactNode,
): string | null {
  if (statusText !== undefined) return statusText === '' ? null : statusText;
  const words = STEP_STATUS_WORDS[state];
  if (words === null || NOTED.has(state)) return words;
  const text = leadingText(title);
  return text !== null && new RegExp(`^\\s*${words}\\b`, 'i').test(text) ? null : words;
}

/** A step's leading icon: the caller's, or its state's. The state's running
 *  icon turns; reduced motion stills it (index.css). */
export function StepIcon({ state, icon }: { state: StepState; icon?: string }) {
  const turns = icon === undefined && state === 'running';
  return (
    <TraceIcon className={turns ? 'animate-spin' : undefined}>
      <Icon name={icon ?? STEP_STATUS_ICONS[state]} size={16} />
    </TraceIcon>
  );
}

export interface StepHeadProps {
  status: StepState;
  /** The state in words: the caller's own, null when the title already says
   *  it, or left out for the state's own (`stepWords`). */
  statusText?: string | null;
  /** An icon name; left out, the state's own icon. */
  icon?: string;
  /** One sentence, in the state's tense. */
  title: ReactNode;
  /** After the title: a server chip, a type badge. */
  after?: ReactNode;
  /** A count or a duration. An unrecorded one is left out, never 0 (CV-05). */
  description?: ReactNode;
  /** A live line under the title: what a running subagent is doing. */
  progress?: ReactNode;
}

/**
 * A step's line, with its state's words: read before the title, and for the
 * five states a stopped turn or a hook leaves, drawn under it too — hidden
 * there from assistive tech, which has already heard them. A span: place it
 * in a trigger or a link to make it do something.
 */
export function StepHead({
  status,
  statusText,
  icon,
  title,
  after,
  description,
  progress,
}: StepHeadProps) {
  const words = stepWords(status, statusText, title);
  return (
    <span data-slot="step-head" data-status={status} className="cb-ai-step-head">
      <TraceLine status={stepTraceStatus(status)} statusText={words}>
        <StepIcon state={status} icon={icon} />
        {/* The title, then what follows it as one group, which wraps under
            the title where the line cannot hold both (trace-steps.css). */}
        <span data-slot="step-body" className="cb-ai-step-body">
          <TraceTitle>{title}</TraceTitle>
          {(hasContent(after) || hasContent(description)) && (
            <span data-slot="step-facts" className="cb-ai-step-facts">
              {after}
              {hasContent(description) && <TraceDescription>{description}</TraceDescription>}
            </span>
          )}
        </span>
      </TraceLine>
      {words !== null && NOTED.has(status) && (
        <span data-slot="step-note" aria-hidden="true" className="cb-ai-step-note">
          {words}
        </span>
      )}
      {progress !== undefined && progress !== null && progress !== '' && (
        <span data-slot="step-progress" className="cb-ai-step-note">
          {progress}
        </span>
      )}
    </span>
  );
}

/** A node that draws something: not left out, null, false or empty. */
function hasContent(node: ReactNode): boolean {
  return node !== undefined && node !== null && node !== false && node !== '';
}

/** A caller's own lines under a step's line — a renderer's extra line —
 *  hung from the title as the step's words are, shown while it is closed. */
export function StepExtra({ children }: { children?: ReactNode }) {
  if (Children.toArray(children).length === 0) return null;
  return (
    <div data-slot="step-extra" className="cb-ai-step-extra">
      {children}
    </div>
  );
}

/**
 * Open state for a step that opens while it works (shadcn's `open ?? running`):
 * the caller's `open` when it passes one, else the reader's last choice, else
 * `defaultOpen`, else `auto`. A reader's click wins over `auto` from then on;
 * `defaultOpen={false}` keeps a step closed while it works.
 */
export function useStepOpen(
  { open, defaultOpen, onOpenChange }: CollapsibleOpenProps,
  auto: boolean,
): { open: boolean; onOpenChange: (open: boolean) => void } {
  const [own, setOwn] = useState<boolean | undefined>(defaultOpen);
  return {
    open: open ?? own ?? auto,
    onOpenChange: (next) => {
      setOwn(next);
      onOpenChange?.(next);
    },
  };
}

/** `one` for exactly one, else `many`. */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** A recorded duration, short: "417ms", "1.4s", "48s", "2m 5s", "1h 3m".
 *  Callers pass only recorded durations, so a negative or non-finite one is a
 *  bad reading — a clock that stepped back — and reads as no time at all,
 *  never "-3ms". */
export function formatDuration(recorded: number): string {
  const ms = Number.isFinite(recorded) && recorded > 0 ? recorded : 0;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${Number((ms / 1000).toFixed(1))}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const rest = seconds % 60;
    return rest === 0 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 60)}m ${rest}s`;
  }
  const minutes = Math.round(seconds / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 60)}h ${rest}m`;
}

/** Opens a vault page, at a line when one is known: the app's own way in,
 *  never an href (CV-16). */
export type OpenPath = (path: string, line?: number, column?: number) => void;

/** What a step needs to open the files it names. */
export interface VaultPathProps {
  /** Opens a vault page; a file a step names is a button only with this. */
  onOpenPath?: OpenPath;
  /** Whether a relative path names a page in this vault. */
  isVaultPath?: (path: string) => boolean;
}

/**
 * A file a step names, as a path the app may open, or null (CV-16). Only a
 * relative path is a vault path — the run's working directory is the vault —
 * and only one that stays inside it and names no scheme; `isVaultPath`, when
 * the caller passes it, has the last word.
 */
export function vaultPathOf(
  file: string | undefined,
  isVaultPath?: (path: string) => boolean,
): string | null {
  if (file === undefined) return null;
  const path = file.trim().replace(/^\.\//, '');
  if (path === '' || originOf(path) !== 'relative') return null;
  // eslint-disable-next-line no-control-regex -- C0 controls and DEL are the match.
  if (/^[a-z][a-z\d+.-]*:/i.test(path) || /[\u0000-\u001f\u007f]/.test(path)) return null;
  if (path.split(/[\\/]/).includes('..')) return null;
  if (isVaultPath !== undefined && !isVaultPath(path)) return null;
  return path;
}
