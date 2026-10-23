// Ported from shadcn/ui at 25af02b, MIT, Copyright (c) 2023 shadcn; see THIRD_PARTY_NOTICES.md.
import {
  Children,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from 'react';
import { IconButton } from '@/components/ui/IconButton';
import { highlight } from '@/workspace/highlighter';
import './code-block.css';

/**
 * Code, terminal output and diffs (M91.7, shadcn's Code Block): a surface with
 * an optional header of title and actions, lines that scroll or wrap, line
 * numbers and marked lines, and a copy button. Highlighting is the app's one
 * Shiki (workspace/highlighter.tsx), which bakes a theme's colours into what
 * it draws, so the theme is the caller's prop: nothing here reads the app's.
 */

export type CodeTheme = 'light' | 'dark';
export type CodeBlockVariant = 'default' | 'destructive';
export type CodeBlockSize = 'default' | 'sm';
export type CodeBlockLineVariant = 'default' | 'added' | 'removed' | 'highlighted';

/** The surface. `destructive` is for errors and failed output; `sm` is
 *  tighter, for tool output inside a trace. */
export function CodeBlock({
  variant = 'default',
  size = 'default',
  className,
  ...props
}: ComponentProps<'div'> & { variant?: CodeBlockVariant; size?: CodeBlockSize }) {
  return (
    <div
      data-slot="code-block"
      {...props}
      data-variant={variant}
      data-size={size}
      className={[
        'cb-ai-code-block',
        variant === 'destructive' && 'cb-ai-code-block-destructive',
        size === 'sm' && 'cb-ai-code-block-sm',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    />
  );
}

/** A row above the code for a title and actions. */
export function CodeBlockHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="code-block-header"
      {...props}
      className={['cb-ai-code-block-header', className].filter(Boolean).join(' ')}
    />
  );
}

/** A filename or a label, with an optional icon before it. It truncates. */
export function CodeBlockTitle({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="code-block-title"
      {...props}
      className={['cb-ai-code-block-title', className].filter(Boolean).join(' ')}
    />
  );
}

/** Buttons at the end of the header. Placed straight in a CodeBlock with no
 *  header, they float over its corner, shown while the block is hovered or
 *  holds focus. */
export function CodeBlockActions({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="code-block-actions"
      {...props}
      className={['cb-ai-code-block-actions', className].filter(Boolean).join(' ')}
    />
  );
}

/** A row below the code, such as for a Show more button. */
export function CodeBlockFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="code-block-footer"
      {...props}
      className={['cb-ai-code-block-footer', className].filter(Boolean).join(' ')}
    />
  );
}

/** How long a copy's outcome shows before the button reads as it did. */
const OUTCOME_MS = 2000;

export interface CodeBlockCopyButtonProps {
  /** The text to copy. */
  value: string;
  /** Its name at rest: "Copy", unless blocks side by side need telling apart. */
  label?: string;
  disabled?: boolean;
  className?: string;
  onClick?: () => void;
}

/**
 * Copies `value`, and says how that went to the eye (its icon and name) and
 * to a screen reader (a polite status). The clipboard is a permission, not a
 * certainty, so a refusal says "Couldn't copy" rather than leaving a button
 * that seems to do nothing.
 */
export function CodeBlockCopyButton({
  value,
  label = 'Copy',
  disabled,
  className,
  onClick,
}: CodeBlockCopyButtonProps) {
  const [outcome, setOutcome] = useState<'copied' | 'failed' | null>(null);
  useEffect(() => {
    if (outcome === null) return;
    const timer = setTimeout(() => setOutcome(null), OUTCOME_MS);
    return () => clearTimeout(timer);
  }, [outcome]);
  const said = outcome === 'copied' ? 'Copied' : outcome === 'failed' ? "Couldn't copy" : null;
  const copy = () => {
    onClick?.();
    try {
      // Written inside the click, which WebKit requires of a clipboard write.
      void navigator.clipboard.writeText(value).then(
        () => setOutcome('copied'),
        () => setOutcome('failed'),
      );
    } catch {
      // No clipboard at all (an insecure context): the same refusal.
      setOutcome('failed');
    }
  };
  return (
    <>
      <IconButton
        icon={outcome === 'copied' ? 'check' : outcome === 'failed' ? 'circle-alert' : 'copy'}
        label={said ?? label}
        size="sm"
        disabled={disabled}
        className={['cb-ai-code-block-copy', className].filter(Boolean).join(' ')}
        onClick={copy}
      />
      <span role="status" aria-live="polite" className="sr-only">
        {said ?? ''}
      </span>
    </>
  );
}

/** What a CodeBlockContent draws: its children, or `code` it highlights. */
type ContentBody =
  | { children?: ReactNode; code?: undefined; language?: undefined; theme?: undefined }
  | {
      /** The text, drawn one CodeBlockLine per line: plain until the grammar
       *  for `language` loads, highlighted for `theme` after. A `diff` marks its
       *  added and removed lines; `ansi` drops its escape codes. */
      code: string;
      language?: string | null;
      theme: CodeTheme;
      children?: undefined;
    };

export type CodeBlockContentProps = Omit<ComponentProps<'pre'>, 'children'> & {
  /** Wrap long lines instead of scrolling them. */
  wrap?: boolean;
  /** Number the lines. A string child is split into lines for it. */
  lineNumbers?: boolean;
  /** The first line's number. */
  startLine?: number;
} & ContentBody;

/**
 * The code: a `pre` that scrolls or wraps, always left to right, focusable so
 * a keyboard can scroll it (`tabIndex={-1}` removes the stop). Its children
 * are a string — one text node, cheap while output streams — or
 * CodeBlockLines; or it draws `code` itself.
 */
export function CodeBlockContent(props: CodeBlockContentProps) {
  const {
    wrap = false,
    lineNumbers = false,
    startLine = 1,
    style,
    className,
    children,
    code: _code,
    language: _language,
    theme: _theme,
    ...pre
  } = props;
  const body =
    props.code !== undefined ? (
      <HighlightedLines code={props.code} language={props.language} theme={props.theme} />
    ) : lineNumbers && typeof children === 'string' ? (
      codeText(children, null)
        .split('\n')
        // A line's identity is its place: there is nothing else to key it on.
        .map((line, index) => <CodeBlockLine key={index}>{line}</CodeBlockLine>)
    ) : (
      children
    );
  return (
    <pre
      data-slot="code-block-content"
      tabIndex={0}
      {...pre}
      dir="ltr"
      data-wrap={wrap ? '' : undefined}
      data-numbered={lineNumbers ? '' : undefined}
      data-language={props.code === undefined ? undefined : (grammarFor(props.language) ?? 'plain')}
      style={{ counterReset: `cb-ai-line ${startLine - 1}`, ...style }}
      className={['cb-ai-code-block-content', className].filter(Boolean).join(' ')}
    >
      <code data-slot="code-block-code" className="cb-ai-code-block-code">
        {body}
      </code>
    </pre>
  );
}

/** One line of code. `added` and `removed` lines are tinted, and a line a
 *  caller marks gets a `+` or `−` drawn before it, outside the selection. */
export function CodeBlockLine({
  variant = 'default',
  className,
  children,
  ...props
}: ComponentProps<'span'> & { variant?: CodeBlockLineVariant }) {
  // An empty line holds a newline, so copying a selection keeps blank lines.
  const empty =
    children === undefined ||
    children === null ||
    children === '' ||
    (Array.isArray(children) && children.length === 0);
  return (
    <span
      data-slot="code-block-line"
      {...props}
      data-variant={variant}
      className={['cb-ai-code-block-line', className].filter(Boolean).join(' ')}
    >
      <span data-slot="code-block-line-content" className="cb-ai-code-block-line-content">
        {empty ? '\n' : children}
      </span>
    </span>
  );
}

/** `code` drawn line by line for CodeBlockContent. */
function HighlightedLines({
  code,
  language,
  theme,
}: {
  code: string;
  language?: string | null;
  theme: CodeTheme;
}) {
  const lines = useHighlightedCode(code, language, theme);
  const marks = useMemo(
    () =>
      grammarFor(language) === 'diff'
        ? diffLineVariants(codeText(code, language).split('\n'))
        : null,
    [code, language],
  );
  // A line's identity is its place: while code streams nothing else is stable.
  return lines.map((line, index) => (
    <CodeBlockLine key={index} variant={marks?.[index]}>
      {line}
    </CodeBlockLine>
  ));
}

/**
 * What each line of a unified diff is, by its first character. Inside a hunk
 * `+` and `-` are changes; before the first `@@`, `+++` and `---` name the
 * files. A diff written by hand, with no hunk header, is all changes.
 */
export function diffLineVariants(lines: readonly string[]): CodeBlockLineVariant[] {
  let hunk = false;
  return lines.map((line) => {
    if (line.startsWith('@@')) {
      hunk = true;
      return 'default';
    }
    if (line.startsWith('diff ')) {
      hunk = false;
      return 'default';
    }
    if (!hunk && (line.startsWith('+++') || line.startsWith('---'))) return 'default';
    if (line.startsWith('+')) return 'added';
    if (line.startsWith('-')) return 'removed';
    return 'default';
  });
}

/** Names that are text, with no grammar to load. */
const PLAIN = new Set(['', 'text', 'txt', 'plain', 'plaintext']);

/**
 * The grammar to highlight `language` with, or null to draw it plain. `ansi` is
 * plain too: the pinned @shikijs/langs ships no `ansi` grammar, so terminal
 * output drops its escape codes and keeps its text. Anything Shiki cannot
 * load draws plain as well (highlight's own fallback).
 */
function grammarFor(language: string | null | undefined): string | null {
  const name = (language ?? '').trim().toLowerCase();
  return PLAIN.has(name) || name === 'ansi' ? null : name;
}

// eslint-disable-next-line no-control-regex -- terminal output's escape codes are control characters: this is the text `ansi` drops.
const ESCAPES = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\))/g;

/** The text a block draws: one kind of line break, no trailing newline (it
 *  would draw an empty last line), and for `ansi` no escape codes. */
function codeText(value: string, language: string | null | undefined): string {
  let text = value.replace(/\r\n/g, '\n');
  if ((language ?? '').trim().toLowerCase() === 'ansi') text = text.replace(ESCAPES, '');
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

/** A highlight pass: what it was given, and the lines it drew. */
interface Highlighted {
  code: string;
  grammar: string;
  theme: CodeTheme;
  lines: ReactNode[];
}

/** Past this many characters a block draws plain: a whole-text Shiki pass
 *  costs more than its colours are worth (Tool's and AiActionCard's limit). */
export const HIGHLIGHT_LIMIT = 20_000;

/** While text keeps growing, at most one pass starts per this many ms: each
 *  pass tokenizes the whole text on the main thread, so one per streamed
 *  delta is quadratic in the block's length. */
export const STREAM_PASS_MS = 120;

/**
 * `value` as one node per line, for CodeBlockLines: plain text until the
 * grammar loads, then Shiki's tokens, highlighted for `theme`. While code
 * streams in it is highlighted again at most every STREAM_PASS_MS, the last
 * text always getting its pass, and until that pass lands the lines the last
 * pass saw whole keep their colours and only the tail draws plain: nothing
 * that was coloured flashes back to plain text. A new theme, or text that is
 * no longer the last pass's plus more, draws plain and starts its own pass at
 * once. Text past HIGHLIGHT_LIMIT draws plain.
 */
export function useHighlightedCode(
  value: string,
  language: string | null | undefined,
  theme: CodeTheme,
): ReactNode[] {
  const code = codeText(value, language);
  const grammar = grammarFor(language);
  const [done, setDone] = useState<Highlighted | null>(null);
  const started = useRef<{ code: string; grammar: string; theme: CodeTheme; at: number } | null>(
    null,
  );
  useEffect(() => {
    if (grammar === null || code.length > HIGHLIGHT_LIMIT) return;
    let live = true;
    const run = () => {
      started.current = { code, grammar, theme, at: Date.now() };
      void highlight(code, grammar, theme).then((drawn) => {
        if (live) setDone({ code, grammar, theme, lines: linesOf(drawn) ?? code.split('\n') });
      });
    };
    const last = started.current;
    const growing =
      last !== null &&
      last.grammar === grammar &&
      last.theme === theme &&
      code !== last.code &&
      code.startsWith(last.code);
    const wait = growing ? last.at + STREAM_PASS_MS - Date.now() : 0;
    const timer = wait > 0 ? setTimeout(run, wait) : undefined;
    if (timer === undefined) run();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [code, grammar, theme]);
  return useMemo(() => {
    const plain = code.split('\n');
    if (grammar === null || done === null || done.grammar !== grammar || done.theme !== theme) {
      return plain;
    }
    if (done.code === code) return done.lines;
    if (!code.startsWith(done.code)) return plain;
    // The pass's last line may have grown since, unless a newline follows it.
    const whole =
      code.charAt(done.code.length) === '\n' ? done.lines.length : done.lines.length - 1;
    return [...done.lines.slice(0, whole), ...plain.slice(whole)];
  }, [code, grammar, theme, done]);
}

type Parent = ReactElement<{ children?: ReactNode }>;

/** The lines of what `highlight` drew — `pre > code > span.line`, in a
 *  fragment — each as its tokens; null for any other shape. */
function linesOf(drawn: ReactNode): ReactNode[] | null {
  const code = find(drawn, 'code');
  if (code === null) return null;
  return Children.toArray(code.props.children).map((line) =>
    isValidElement<{ children?: ReactNode }>(line) ? line.props.children : line,
  );
}

function find(node: ReactNode, tag: string): Parent | null {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode }>(child)) continue;
    if (child.type === tag) return child;
    const inner = find(child.props.children, tag);
    if (inner !== null) return inner;
  }
  return null;
}
