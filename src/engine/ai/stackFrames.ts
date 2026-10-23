/**
 * An error's stack, split into frames (M91.10, Q11). Pure: no DOM, no store,
 * no IPC.
 *
 * Reads the traces a failed command prints: V8 (Node, Chromium), the `fn@url`
 * form of Firefox and Safari, a Rust panic and its backtrace, a Python
 * traceback and a Go panic. Anything else is no trace (null), and the view
 * shows the error as plain text. Every frame is one the text printed, none is
 * inferred, and they come innermost first (the call that failed) whatever
 * order the runtime printed them in.
 *
 * A frame's `origin` says what its file names. Only a relative path is a
 * candidate to open in the app, once the caller has checked that it names a
 * vault page (CV-16); an absolute path, a URL and the runtime's own code
 * (`node:internal/…`, `<frozen …>`) stay text.
 */

import { terminalLines } from './terminalText';

export type FrameOrigin = 'relative' | 'absolute' | 'url' | 'internal';

export interface StackFrame {
  /** The function, as printed. */
  fn?: string;
  file?: string;
  line?: number;
  column?: number;
  /** The frame's own text, trimmed: two lines for a Rust or Go frame. */
  raw: string;
  /** What `file` names; present exactly when `file` is. */
  origin?: FrameOrigin;
}

export interface StackTrace {
  language: 'javascript' | 'rust' | 'python' | 'go';
  /** The error the frames belong to, as printed; empty when the trace
   * printed none (a Firefox stack holds frames only). */
  message: string;
  /** Innermost first. */
  frames: StackFrame[];
}

export function parseStackTrace(text: string): StackTrace | null {
  const lines = terminalLines(text);
  // Rust's backtrace prints `at file:line` lines a V8 reader would take, so
  // the other forms are tried first.
  return python(lines) ?? go(lines) ?? rust(lines) ?? v8(lines) ?? gecko(lines);
}

export function originOf(file: string): FrameOrigin {
  if (/^node:|^<.*>$|^\[native code\]$/.test(file)) return 'internal';
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(file)) return 'url';
  if (/^(?:\/|~|\\\\|[a-z]:[\\/])/i.test(file)) return 'absolute';
  return 'relative';
}

function frame(
  raw: string,
  fn?: string,
  file?: string,
  line?: string,
  column?: string,
): StackFrame {
  const out: StackFrame = { raw };
  if (fn !== undefined && fn !== '') out.fn = fn;
  if (file !== undefined && file !== '') {
    out.file = file.replace(/^\.\//, '');
    out.origin = originOf(out.file);
  }
  if (line !== undefined) out.line = Number(line);
  if (column !== undefined) out.column = Number(column);
  return out;
}

/** The lines directly above `index`, up to the blank line before them. */
function paragraphAbove(lines: readonly string[], index: number): string {
  let start = index;
  while (start > 0 && lines[start - 1].trim() !== '') start -= 1;
  return lines
    .slice(start, index)
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

const ERROR_HEADER = /^\s*(?:Uncaught )?(?:[A-Z][\w$]*)?(?:Error|Exception)\b/;

/** A JavaScript error's words above its first frame: from the nearest line
 * that names an error (`TypeError: …`, `AssertionError [ERR_ASSERTION]: …`),
 * so a message of several paragraphs stays whole; else the paragraph above. */
function messageAbove(lines: readonly string[], first: number): string {
  for (let i = first - 1; i >= Math.max(0, first - 12); i--) {
    if (!ERROR_HEADER.test(lines[i])) continue;
    return lines
      .slice(i, first)
      .map((line) => line.trimEnd())
      .join('\n')
      .trim();
  }
  return paragraphAbove(lines, first);
}

/** The lines from `index` up to the next blank line. */
function paragraphFrom(lines: readonly string[], index: number): string {
  let end = index;
  while (end < lines.length && lines[end].trim() !== '') end += 1;
  return lines
    .slice(index, end)
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

// ---------------------------------------------------------------------------
// V8: `    at fn (file:line:col)`, `    at file:line:col`.
// ---------------------------------------------------------------------------

const V8_CAUSE_ELIDED = /^\s+\.\.\. \d+ lines? matching cause stack trace \.\.\.$/;

function v8Frame(line: string): StackFrame | null {
  // Node prints ` {` after the last frame of an error that has properties.
  const m = /^\s+at (.+?)(?: \{)?$/.exec(line);
  if (m === null) return null;
  const raw = `at ${m[1]}`;
  const call = /^(.+?) \((.+)\)$/.exec(m[1]);
  const where = call === null ? m[1] : call[2];
  const at = /^(.+?):(\d+)(?::(\d+))?$/.exec(where);
  if (at !== null && !where.startsWith('eval at ')) {
    return frame(raw, call?.[1], at[1], at[2], at[3]);
  }
  // `at Array.map (<anonymous>)`, `at async Promise.all (index 0)`: a call
  // with no file of its own.
  if (call !== null && /^(?:<anonymous>|native|index \d+|eval at .*)$/.test(where)) {
    return frame(raw, call[1]);
  }
  return null;
}

function v8(lines: readonly string[]): StackTrace | null {
  const first = lines.findIndex((line) => v8Frame(line) !== null);
  if (first === -1) return null;
  const frames: StackFrame[] = [];
  for (let i = first; i < lines.length; i++) {
    if (V8_CAUSE_ELIDED.test(lines[i])) continue;
    const parsed = v8Frame(lines[i]);
    if (parsed === null) break;
    frames.push(parsed);
  }
  return { language: 'javascript', message: messageAbove(lines, first), frames };
}

// ---------------------------------------------------------------------------
// Firefox and Safari: `fn@url:line:col`.
// ---------------------------------------------------------------------------

function geckoFrame(line: string): StackFrame | null {
  const text = line.trim();
  const native = /^(.*?)@\[native code\]$/.exec(text);
  if (native !== null) return frame(text, native[1]);
  const m = /^(.*?)@(.+?):(\d+):(\d+)$/.exec(text);
  // A file that is neither a URL nor a path is an address, not a frame.
  if (m === null || !/[/\\]|^[a-z][a-z\d+.-]*:/i.test(m[2])) return null;
  return frame(text, m[1], m[2], m[3], m[4]);
}

function gecko(lines: readonly string[]): StackTrace | null {
  const first = lines.findIndex((line) => geckoFrame(line) !== null);
  if (first === -1) return null;
  const frames: StackFrame[] = [];
  for (let i = first; i < lines.length; i++) {
    const parsed = geckoFrame(lines[i]);
    if (parsed === null) break;
    frames.push(parsed);
  }
  return { language: 'javascript', message: messageAbove(lines, first), frames };
}

// ---------------------------------------------------------------------------
// Rust: `thread 'main' panicked at src/main.rs:5:5:` and `stack backtrace:`.
// ---------------------------------------------------------------------------

const RUST_PANIC = /^thread '.*'(?: \(\d+\))? panicked at (.+?):(\d+):(\d+):$/;
const RUST_PANIC_QUOTED = /^thread '.*'(?: \(\d+\))? panicked at '(.*)', (.+?):(\d+):(\d+)$/;
const RUST_BACKTRACE = /^stack backtrace:$/i;
const RUST_FRAME = /^\s*(\d+):\s+(?:0x[\da-f]+ - )?(.+)$/;
const RUST_AT = /^\s+at (.+?):(\d+)(?::(\d+))?$/;

function rust(lines: readonly string[]): StackTrace | null {
  const panicAt = lines.findIndex((line) => RUST_PANIC.test(line) || RUST_PANIC_QUOTED.test(line));
  const backtraceAt = lines.findIndex((line, i) => i > panicAt && RUST_BACKTRACE.test(line.trim()));
  if (panicAt === -1 && backtraceAt === -1) return null;

  let message = '';
  let site: StackFrame | null = null;
  if (panicAt !== -1) {
    const panic = lines[panicAt].trim();
    const quoted = RUST_PANIC_QUOTED.exec(panic);
    const plain = RUST_PANIC.exec(panic);
    if (quoted !== null) {
      message = quoted[1];
      site = frame(panic, undefined, quoted[2], quoted[3], quoted[4]);
    } else if (plain !== null) {
      // The message runs from the next line to a note, the backtrace or a blank.
      const body: string[] = [];
      for (let i = panicAt + 1; i < lines.length; i++) {
        const text = lines[i].trimEnd();
        if (text.trim() === '' || /^note: /.test(text) || RUST_BACKTRACE.test(text.trim())) break;
        body.push(text);
      }
      message = body.join('\n').trim();
      site = frame(panic, undefined, plain[1], plain[2], plain[3]);
    }
  } else {
    message = paragraphAbove(lines, backtraceAt);
  }

  const frames: StackFrame[] = [];
  if (backtraceAt !== -1) {
    for (let i = backtraceAt + 1; i < lines.length; i++) {
      const head = RUST_FRAME.exec(lines[i]);
      if (head === null) break;
      const at = i + 1 < lines.length ? RUST_AT.exec(lines[i + 1]) : null;
      const raw = `${lines[i].trim()}${at === null ? '' : `\n${lines[i + 1].trim()}`}`;
      frames.push(frame(raw, head[2], at?.[1], at?.[2], at?.[3]));
      if (at !== null) i += 1;
    }
  }
  // Without a backtrace the panic's own site is the one place printed.
  if (frames.length === 0 && site !== null) frames.push(site);
  if (frames.length === 0) return null;
  return { language: 'rust', message, frames };
}

// ---------------------------------------------------------------------------
// Python: `Traceback (most recent call last):`, outermost first.
// ---------------------------------------------------------------------------

const PY_HEADER = /^Traceback \(most recent call last\):$/;
const PY_FRAME = /^\s+File "(.+)", line (\d+)(?:, in (.+))?$/;
/** Python 3.11's markers under a frame's source line. */
const PY_MARKERS = /^\s*[~^]+\s*$/;

function python(lines: readonly string[]): StackTrace | null {
  // A chained exception prints its cause's traceback first: the last one is
  // the error that ended the program.
  let header = lines.length - 1;
  while (header >= 0 && !PY_HEADER.test(lines[header].trim())) header -= 1;
  if (header === -1) return null;
  const frames: StackFrame[] = [];
  let i = header + 1;
  while (i < lines.length) {
    const m = PY_FRAME.exec(lines[i]);
    if (m === null) {
      // A frame's source line and its markers, indented under it.
      if (/^\s/.test(lines[i]) && lines[i].trim() !== '') {
        i += 1;
        continue;
      }
      break;
    }
    const source = lines[i + 1];
    const shown =
      source !== undefined &&
      /^\s/.test(source) &&
      !PY_FRAME.test(source) &&
      !PY_MARKERS.test(source) &&
      source.trim() !== '';
    const raw = shown ? `${lines[i].trim()}\n${source.trim()}` : lines[i].trim();
    frames.push(frame(raw, m[3], m[1], m[2]));
    i += 1;
  }
  if (frames.length === 0) return null;
  const message = i < lines.length ? paragraphFrom(lines, i) : '';
  return { language: 'python', message, frames: frames.reverse() };
}

// ---------------------------------------------------------------------------
// Go: `panic: …`, then the panicking goroutine's calls and their files.
// ---------------------------------------------------------------------------

const GO_PANIC = /^panic: (.+)$/;
const GO_GOROUTINE = /^goroutine \d+ \[.+\]:$/;
const GO_AT = /^\t(.+?):(\d+)(?: \+0x[\da-f]+)?$/;

function go(lines: readonly string[]): StackTrace | null {
  const panicAt = lines.findIndex((line) => GO_PANIC.test(line));
  if (panicAt === -1) return null;
  const goroutine = lines.findIndex((line, i) => i > panicAt && GO_GOROUTINE.test(line));
  if (goroutine === -1) return null;
  const frames: StackFrame[] = [];
  for (let i = goroutine + 1; i + 1 < lines.length; i += 2) {
    const call = lines[i];
    const at = GO_AT.exec(lines[i + 1]);
    if (call.trim() === '' || /^\s/.test(call) || at === null) break;
    // `main.(*T).M(0x14000)`: the arguments are the last parentheses.
    const fn = /^(.*)\([^()]*\)$/.exec(call)?.[1] ?? call;
    frames.push(frame(`${call}\n${lines[i + 1].trim()}`, fn, at[1], at[2]));
  }
  if (frames.length === 0) return null;
  const message = paragraphFrom(lines, panicAt).replace(/^panic: /, '');
  return { language: 'go', message, frames };
}
