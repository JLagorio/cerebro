// Ported from shadcn/ui at 25af02b, MIT, Copyright (c) 2023 shadcn; see THIRD_PARTY_NOTICES.md.
import { useMemo, type ComponentProps, type ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import { parseStackTrace, type StackFrame } from '@/engine/ai/stackFrames';
import { CodeBlock, CodeBlockContent, CodeBlockCopyButton } from './CodeBlock';
import type { CollapsibleOpenProps } from './Collapsible';
import { StepHead, plural, useStepOpen, vaultPathOf, type VaultPathProps } from './StepLine';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from './Trace';
import './trace-steps.css';

/**
 * An error and the frames it was raised through (M91.9, shadcn's Stack
 * Trace): the error is the line's title, "Failed: TypeError: …", and the
 * line opens onto the whole error and its frames, innermost first. The
 * frames are only those the text printed (engine/ai/stackFrames.ts, Q11);
 * text with no trace in it is shown as the error it is, with none invented.
 *
 * A frame opens its file only when the file is a page in this vault — a
 * relative path, through `onOpenPath`, never an href (CV-16); any other frame
 * is text. The runtime's and the libraries' frames fold into a line of their
 * own, so the frames you can fix come first.
 */

/** A path through a package store, or the Rust toolchain's own sources. */
const LIBRARY =
  /(?:^|[\\/])(?:node_modules|site-packages|dist-packages)[\\/]|[\\/]\.cargo[\\/]registry[\\/]|^\/rustc\//;

/** A frame from the runtime or a library, or one that names no file. */
function isLibraryFrame(frame: StackFrame): boolean {
  return frame.file === undefined || frame.origin === 'internal' || LIBRARY.test(frame.file);
}

/** "formatInvoice in app/lib/billing.ts:42", or the frame as printed when
 *  it names no file. */
function frameText(frame: StackFrame): string {
  if (frame.file === undefined) return frame.raw;
  const at = frame.line === undefined ? frame.file : `${frame.file}:${frame.line}`;
  return frame.fn === undefined ? at : `${frame.fn} in ${at}`;
}

/** One frame: a button that opens its file when the file is a vault page,
 *  else its text. */
function FrameLine({ frame, onOpenPath, isVaultPath }: VaultPathProps & { frame: StackFrame }) {
  const path = onOpenPath === undefined ? null : vaultPathOf(frame.file, isVaultPath);
  if (path === null || onOpenPath === undefined) {
    return (
      <TraceLine data-frame="">
        <TraceIcon>
          <Icon name="file-code" />
        </TraceIcon>
        <TraceTitle>{frameText(frame)}</TraceTitle>
      </TraceLine>
    );
  }
  return (
    <button
      type="button"
      data-frame=""
      className="cb-ai-step-link"
      onClick={() => onOpenPath(path, frame.line, frame.column)}
    >
      <TraceLine>
        <TraceIcon>
          <Icon name="file-code" />
        </TraceIcon>
        <TraceTitle>
          <span className="sr-only">Open </span>
          {frameText(frame)}
        </TraceTitle>
        <TraceIcon>
          <Icon name="arrow-up-right" />
        </TraceIcon>
      </TraceLine>
    </button>
  );
}

/** The frames, innermost first: the ones you can fix as lines, the
 *  runtime's and the libraries' folded into a line of their own. */
export function StackTraceFrames({
  frames,
  onOpenPath,
  isVaultPath,
  className,
  ...props
}: Omit<ComponentProps<'div'>, 'children'> & VaultPathProps & { frames: readonly StackFrame[] }) {
  const listed = frames.filter((frame) => !isLibraryFrame(frame));
  const library = frames.filter(isLibraryFrame);
  return (
    <Trace data-slot="stack-trace-frames" {...props} className={className}>
      {listed.map((frame, index) => (
        // A frame's identity is its place: one call can recur in a stack.
        <FrameLine key={index} frame={frame} onOpenPath={onOpenPath} isVaultPath={isVaultPath} />
      ))}
      {library.length > 0 && (
        <TraceCollapsible data-slot="stack-trace-library">
          <TraceCollapsibleTrigger>
            <TraceLine>
              <TraceIcon>
                <Icon name="layers" />
              </TraceIcon>
              <TraceTitle>
                {plural(library.length, 'library or runtime frame', 'library and runtime frames')}
              </TraceTitle>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent>
            <ol className="cb-ai-stack-frames">
              {library.map((frame, index) => (
                <li key={index}>{frame.raw}</li>
              ))}
            </ol>
          </TraceCollapsibleContent>
        </TraceCollapsible>
      )}
    </Trace>
  );
}

/** The error's first line, for the title, which truncates. */
function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
  );
}

export type StackTraceProps = Omit<ComponentProps<'div'>, 'title' | 'children'> &
  CollapsibleOpenProps &
  VaultPathProps & {
    /** The error as the command printed it. */
    trace: string;
    /** The line's sentence; left out, "Failed: " and the error's first line. */
    title?: ReactNode;
  };

/** A failed call's error. It starts closed; the whole error repeats inside,
 *  since the title truncates. Copy takes the text as printed. */
export function StackTrace({
  trace,
  title,
  onOpenPath,
  isVaultPath,
  open,
  defaultOpen,
  onOpenChange,
  className,
  ...props
}: StackTraceProps) {
  const opened = useStepOpen({ open, defaultOpen, onOpenChange }, false);
  const parsed = useMemo(() => parseStackTrace(trace), [trace]);
  const message = parsed === null ? trace.trim() : parsed.message;
  const first = firstLine(message);
  return (
    <TraceCollapsible
      data-slot="stack-trace"
      data-status="failed"
      data-language={parsed?.language}
      {...props}
      className={className}
      open={opened.open}
      onOpenChange={opened.onOpenChange}
    >
      <TraceCollapsibleTrigger>
        <StepHead
          status="failed"
          icon="circle-x"
          title={title ?? (first === '' ? 'Failed with no message' : `Failed: ${first}`)}
        />
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent keepMounted className="cb-ai-step-detail">
        {message !== '' && (
          <CodeBlock size="sm" variant="destructive" data-slot="stack-trace-error">
            <CodeBlockContent wrap className="cb-ai-step-code">
              {message}
            </CodeBlockContent>
          </CodeBlock>
        )}
        {parsed !== null && (
          <StackTraceFrames
            frames={parsed.frames}
            onOpenPath={onOpenPath}
            isVaultPath={isVaultPath}
          />
        )}
        <div className="cb-ai-step-actions">
          <CodeBlockCopyButton value={trace} label="Copy the error" />
        </div>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}
