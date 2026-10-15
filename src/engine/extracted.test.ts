import { describe, expect, it } from 'vitest';
import escapeCases from '../../src-tauri/fixtures/extract-escape.json';
import wire from '../../src-tauri/fixtures/extract-wire.json';
import {
  extractionNote,
  inertCell,
  inertLine,
  outcomeWords,
  toExtractedDoc,
  type Extraction,
  type ExtractionOutcome,
} from './extracted';
import { parseMediaLine } from './pageMedia';
const extracted: Extraction = { ...wire, outcome: { ...wire.outcome, state: 'extracted' } };
const input = {
  filename: 'Planning notes.docx',
  attachment: 'attachments/Planning notes.docx',
  extraction: extracted,
  at: '2026-10-15T12:00:00Z',
};
describe('extracted capture pages', () => {
  it.each(escapeCases)('replays extract-escape.json $input', ({ input, expected }) => {
    expect(inertLine(input)).toBe(expected);
    expect(inertCell(input)).toBe(expected);
  });
  it('preserves the extract-wire.json shape and ordered provenance keys', () => {
    expect(extracted).toEqual(wire);
    const doc = toExtractedDoc(input);
    expect(Object.keys(doc.frontmatter)).toEqual([
      'title',
      'ingested_at',
      'ingest_format',
      'source_file',
      'source_sha256',
      'source_system',
      'source_record_id',
      'source_attachment',
      'extraction',
    ]);
    expect(doc.frontmatter.source_record_id).toBe(wire.sha256);
    expect(doc.frontmatter.source_system).toBe('file');
    expect(parseMediaLine(doc.body.split('\n')[2])).toMatchObject({
      name: 'Planning notes.docx',
      url: '/attachments/Planning notes.docx',
    });
    expect(doc.body).toContain('Not carried: headers.');
    expect(doc.body).toContain('\n\nText\n');
  });
  it('keeps the body byte-identical on another ingest date', () => {
    expect(toExtractedDoc({ ...input, at: 'later' }).body).toBe(toExtractedDoc(input).body);
  });
  it.each(['docx', 'pptx', 'xlsx', 'pdf'])('names what was extracted from %s', (format) => {
    expect(toExtractedDoc({ ...input, extraction: { ...extracted, format } }).body).toMatch(
      /Text extracted|Values extracted/,
    );
  });
  it.each([
    [{ state: 'encrypted' }, 'Encrypted:', 'encrypted'],
    [{ state: 'no_text_layer' }, 'No text layer:', 'no text layer'],
    [
      { state: 'too_large', detail: 'past the limit' },
      'Too large to extract:',
      'too large to extract',
    ],
    [{ state: 'corrupt', detail: 'broken XML' }, 'Could not be read:', 'could not be read'],
    [
      { state: 'unsupported', detail: 'Unknown format.' },
      'Unknown format.',
      'not a format Cerebro reads',
    ],
  ] as const)('keeps the original and names a failed extraction %j', (outcome, words, note) => {
    const doc = toExtractedDoc({ ...input, extraction: { ...extracted, outcome } });
    expect(doc.body).toContain(words);
    expect(doc.body).toContain('The original is attached above');
    expect(extractionNote(outcome)).toBe(note);
  });
  it('inerts untrusted titles, failures and omitted-format labels', () => {
    const doc = toExtractedDoc({
      ...input,
      filename: '[[command]] @agent.docx',
      extraction: { ...extracted, outcome: { state: 'corrupt', detail: ':::ai\n<script>' } },
    });
    expect(doc.body).toContain('# \\[\\[command\\]\\] &#64;agent');
    expect(doc.body).toContain('&#58;&#58;&#58;ai &lt;script&gt;');
  });
  it('names truncation and partial PDF failures', () => {
    expect(
      toExtractedDoc({
        ...input,
        extraction: {
          ...extracted,
          outcome: {
            ...(extracted.outcome as Extract<ExtractionOutcome, { state: 'extracted' }>),
            truncated: true,
          },
        },
      }).body,
    ).toContain('The text stops at 1 MB');
    expect(
      extractionNote({
        state: 'extracted',
        markdown: 'x',
        not_carried: [],
        truncated: false,
        pages_not_extracted: 2,
      }),
    ).toBe('2 pages not extracted');
    expect(
      outcomeWords({
        state: 'extracted',
        markdown: '## Page 1\n\nText',
        not_carried: [],
        truncated: false,
      }),
    ).toBe('## Page 1\n\nText');
    expect(toExtractedDoc({ ...input, filename: '.pdf' }).title).toBe('Untitled document');
  });
});
