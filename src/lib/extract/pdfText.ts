/** Text-only PDF capture using the one upstream loader; this module imports no PDF engine. */
import { openPdf } from '@/workspace/viewers/pdf/pdfjs';
import { inertLine, type ExtractionOutcome } from '@/engine/extracted';

interface TextItem {
  str: string;
  transform?: number[];
  width?: number;
  height?: number;
  hasEOL?: boolean;
}
interface TextPage {
  getTextContent(): Promise<{ items: unknown[] }>;
}
export interface TextDocument {
  numPages: number;
  getPage(page: number): Promise<TextPage>;
  destroy(): Promise<void>;
}
export type OpenTextPdf = (
  bytes: Uint8Array,
) => Promise<
  { ok: true; doc: TextDocument } | { ok: false; reason: 'encrypted' | 'corrupt' | 'engine' }
>;
export interface PdfTextLimits {
  pages: number;
  bytes: number;
  pageMs: number;
  totalMs: number;
}
export const PDF_TEXT_LIMITS: PdfTextLimits = {
  pages: 300,
  bytes: 1024 * 1024,
  pageMs: 10_000,
  totalMs: 120_000,
};
class Deadline extends Error {
  constructor() {
    super('the reader took too long');
  }
}
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Deadline()), Math.max(0, ms));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const encoder = new TextEncoder();
function cutBytes(text: string, limit: number): string {
  let bytes = 0;
  let out = '';
  for (const char of text) {
    const n = encoder.encode(char).byteLength;
    if (bytes + n > limit) break;
    bytes += n;
    out += char;
  }
  return out;
}
/** Positioned text becomes lines; a larger baseline gap separates paragraphs.
 * Stop constructing strings at a bounded source-character count before escaping. */
export function textOfItems(items: readonly unknown[], maxChars = 1024 * 1024): string {
  const pieces: string[] = [];
  let characters = 0;
  let lastY: number | null = null;
  let lastEnd: number | null = null;
  let ended = false;
  const append = (value: string) => {
    const part = value.slice(0, Math.max(0, maxChars - characters));
    pieces.push(part);
    characters += part.length;
  };
  for (const raw of items) {
    if (raw === null || typeof raw !== 'object' || !('str' in raw) || typeof raw.str !== 'string')
      continue;
    const item = raw as TextItem;
    const [x, y] = [item.transform?.[4], item.transform?.[5]];
    const height = Math.max(1, Math.abs(item.height ?? item.transform?.[3] ?? 10));
    if (
      typeof y === 'number' &&
      Number.isFinite(y) &&
      lastY !== null &&
      Math.abs(y - lastY) > height * 0.35
    ) {
      append(Math.abs(y - lastY) > height * 1.8 ? '\n\n' : '\n');
    } else if (ended) append('\n');
    else if (pieces.length > 0 && (typeof x !== 'number' || lastEnd === null || x - lastEnd > 0.5))
      append(' ');
    const remaining = Math.max(0, maxChars - characters);
    let text = '';
    for (const char of item.str) {
      if (text.length + char.length > remaining) break;
      text += char;
    }
    append(text);
    if (characters >= maxChars) break;
    if (typeof y === 'number' && Number.isFinite(y)) lastY = y;
    lastEnd = typeof x === 'number' && Number.isFinite(x) ? x + (item.width ?? 0) : null;
    ended = item.hasEOL === true;
  }
  return pieces.join('').trim();
}
function reason(error: unknown): string {
  return error instanceof Error
    ? [...error.message].slice(0, 500).join('')
    : 'the page could not be read';
}
/** A failed page is explicit; a failed read never masquerades as an empty PDF.
 * The total deadline includes opening. A late open is destroyed after timeout. */
export async function extractPdfText(
  bytes: Uint8Array,
  open: OpenTextPdf = openPdf,
  limits: PdfTextLimits = PDF_TEXT_LIMITS,
): Promise<ExtractionOutcome> {
  const started = Date.now();
  let doc: TextDocument | undefined;
  let abandoned = false;
  try {
    const opening = open(bytes);
    void opening.then(
      (result) => {
        if (abandoned && result.ok) void result.doc.destroy().catch(() => undefined);
      },
      () => undefined,
    );
    const opened = await within(opening, limits.totalMs);
    if (!opened.ok)
      return opened.reason === 'encrypted'
        ? { state: 'encrypted' }
        : opened.reason === 'engine'
          ? { state: 'unsupported', detail: 'The PDF reader is unavailable.' }
          : { state: 'corrupt', detail: 'The PDF could not be opened.' };
    doc = opened.doc;
    if (!Number.isInteger(doc.numPages) || doc.numPages < 1)
      return { state: 'corrupt', detail: 'The PDF has no readable page count.' };
    const pages: string[] = [];
    let used = 0;
    let textPages = 0;
    let emptyPages = 0;
    let failures = 0;
    let retainedFailures = 0;
    let shown = 0;
    let truncated = false;
    const count = Math.min(doc.numPages, limits.pages);
    for (let page = 1; page <= count; page += 1) {
      const remainingMs = limits.totalMs - (Date.now() - started);
      if (remainingMs <= 0) break;
      let section: string;
      let failed = false;
      try {
        const content = await within(
          (async () => (await doc!.getPage(page)).getTextContent())(),
          Math.min(limits.pageMs, remainingMs),
        );
        const raw = textOfItems(content.items, limits.bytes + 1);
        if (raw.length === 0) {
          emptyPages += 1;
          section = `## Page ${page}\n\nPage ${page}: no text on this page.`;
        } else {
          textPages += 1;
          section = `## Page ${page}\n\n${raw.split('\n').map(inertLine).join('\n')}`;
        }
      } catch (error) {
        failures += 1;
        failed = true;
        section = `## Page ${page}\n\nPage ${page}: text not extracted (${inertLine(reason(error))}).`;
      }
      const separator = pages.length > 0 ? '\n\n' : '';
      const size = encoder.encode(separator + section).byteLength;
      if (used + size > limits.bytes) {
        if (pages.length === 0) pages.push(cutBytes(section, limits.bytes));
        truncated = true;
        break;
      }
      pages.push(section);
      if (failed) retainedFailures += 1;
      used += size;
      shown = page;
    }
    const omitted = doc.numPages - shown;
    if (shown < doc.numPages && !truncated) {
      const hint = `\n\nPages ${shown + 1}–${doc.numPages} are not extracted here; the original has them.`;
      if (used + encoder.encode(hint).byteLength <= limits.bytes) pages.push(hint.trimStart());
      else truncated = true;
    }
    if (textPages === 0 && emptyPages === doc.numPages) return { state: 'no_text_layer' };
    if (textPages === 0 && emptyPages === 0)
      return {
        state: 'corrupt',
        detail: failures > 0 ? 'No page could be read.' : 'The PDF reader took too long.',
      };
    return {
      state: 'extracted',
      markdown: pages.join('\n\n'),
      not_carried: [],
      truncated,
      ...(retainedFailures + omitted > 0
        ? { pages_not_extracted: retainedFailures + omitted }
        : {}),
    };
  } catch (error) {
    return error instanceof Error && error.name === 'PasswordException'
      ? { state: 'encrypted' }
      : { state: 'corrupt', detail: reason(error) };
  } finally {
    abandoned = true;
    if (doc) {
      // A broken worker must not keep an import waiting forever in cleanup.
      await within(
        doc.destroy().catch(() => undefined),
        1000,
      ).catch(() => undefined);
    }
  }
}
