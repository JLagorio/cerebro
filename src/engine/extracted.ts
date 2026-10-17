/** Inert, provenance-carrying pages made from bounded document readers (M66.7c). */
import { formatMediaLine } from './pageMedia';
import type { Scalar } from './types';

export type ExtractionOutcome =
  | {
      state: 'extracted';
      markdown: string;
      not_carried: string[];
      truncated: boolean;
      pages_not_extracted?: number;
    }
  | { state: 'no_text_layer' }
  | { state: 'encrypted' }
  | { state: 'too_large' | 'corrupt' | 'unsupported'; detail: string };
export interface Extraction {
  format: string;
  sha256: string;
  bytes: number;
  outcome: ExtractionOutcome;
}
/** D3: files/extract/markdown.rs replays extract-escape.json too. */
export function inertLine(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (char === '\n' || char === '\r' || char === '\t') out += ' ';
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    else if (char === '&') out += '&amp;';
    else if (char === '<') out += '&lt;';
    else if (char === '>') out += '&gt;';
    else if ('\\[]()*_`#!|~{}'.includes(char)) out += `\\${char}`;
    else if (char === ':') out += '&#58;';
    else if (char === '@') out += '&#64;';
    else if (char === '📅') out += '&#128197;';
    else out += char;
  }
  // Rust trim_start is Unicode White_Space (FEFF is not whitespace there).
  // Controls have already become spaces or been removed above.
  const leading = out.match(
    /^[\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*/u,
  )![0].length;
  if (/^(?:[-+=]|\d+[.)])/.test(out.slice(leading)))
    out = `${out.slice(0, leading)}\\${out.slice(leading)}`;
  return out;
}
export const inertCell = inertLine;
const INTRO: Record<string, string> = {
  docx: 'Text extracted from the attached document. Headings, lists, tables and links are kept; other formatting is not.',
  pptx: "Text extracted from the attached slides, with each slide's speaker notes.",
  xlsx: 'Values extracted from the attached workbook.',
  pdf: 'Text extracted from the attached PDF, page by page.',
};
export function outcomeWords(outcome: ExtractionOutcome): string {
  switch (outcome.state) {
    case 'extracted':
      return outcome.markdown;
    case 'no_text_layer':
      return 'No text layer: this PDF holds only images of its pages, so there is no text to extract. The original is attached above.';
    case 'encrypted':
      return 'Encrypted: this file needs a password, so Cerebro could not read its text. The original is attached above.';
    case 'too_large':
      return `Too large to extract: ${inertLine(outcome.detail)}. The original is attached above.`;
    case 'corrupt':
      return `Could not be read: ${inertLine(outcome.detail)}. The original is attached above, unchanged.`;
    case 'unsupported':
      return `${inertLine(outcome.detail)} The original is attached above.`;
  }
}
export function extractionNote(outcome: ExtractionOutcome): string | null {
  switch (outcome.state) {
    case 'no_text_layer':
      return 'no text layer';
    case 'encrypted':
      return 'encrypted';
    case 'too_large':
      return 'too large to extract';
    case 'corrupt':
      return 'could not be read';
    case 'unsupported':
      return 'not a format Cerebro reads';
    case 'extracted':
      return outcome.truncated
        ? 'text cut at 1 MB'
        : outcome.pages_not_extracted
          ? `${outcome.pages_not_extracted} pages not extracted`
          : null;
  }
}
export function toExtractedDoc(input: {
  filename: string;
  attachment: string;
  extraction: Extraction;
  at: string;
}): { title: string; frontmatter: Record<string, Scalar>; body: string } {
  const filename = input.filename.split(/[\\/]/).at(-1) ?? input.filename;
  const title =
    filename.replace(/\.(?:docx|pptx|xlsx|xlsm|pdf)$/i, '').trim() || 'Untitled document';
  const { format, sha256, outcome } = input.extraction;
  const frontmatter: Record<string, Scalar> = {
    title,
    ingested_at: input.at,
    ingest_format: format,
    source_file: filename,
    source_sha256: sha256,
    source_system: 'file',
    source_record_id: sha256,
    source_attachment: input.attachment,
    extraction: outcome.state,
  };
  const sections = [
    `# ${inertLine(title)}`,
    formatMediaLine({ name: filename, url: `/${input.attachment}`, caption: '' }),
    INTRO[format] ?? 'The original document is attached above.',
  ];
  if (outcome.state === 'extracted' && outcome.not_carried.length > 0)
    sections.push(`Not carried: ${outcome.not_carried.map(inertLine).join(', ')}.`);
  sections.push(outcomeWords(outcome));
  if (outcome.state === 'extracted' && outcome.truncated)
    sections.push('The text stops at 1 MB; the rest is in the original.');
  return { title, frontmatter, body: `${sections.filter(Boolean).join('\n\n').trimEnd()}\n` };
}
