import { describe, expect, it } from 'vitest';
import { fileChip, placeChip, recordChip } from '@/agent/contextChips';
import { composerFiles, FILE_WORDS, KIND_WORDS, type PendingView } from './attachments';
import { makeEntry } from '@/test/factories';

/**
 * The composer's files (M91.17), as the Attachment element draws them: the
 * attached files in the vault, then the ones waiting to be copied in, each
 * with its kind in words and where its copy stands.
 */

const entries = [makeEntry({ path: 'docs/spec.md', title: 'The spec' })];

const waiting = (over: Partial<PendingView> = {}): PendingView => ({
  id: 'pending:1',
  label: 'Q3 report.pdf',
  fileKind: 'pdf',
  state: 'waiting',
  ...over,
});

describe('composerFiles', () => {
  it('draws a file chip by its vault path, from the vault root, under its chip id', () => {
    expect(composerFiles([fileChip('attachments/screen.png')], [])).toEqual([
      {
        data: {
          id: 'file:attachments/screen.png',
          label: 'screen.png',
          path: 'attachments/screen.png',
          rootId: '0',
          kind: 'image',
          description: 'Image',
        },
        state: 'done',
      },
    ]);
  });

  it('leaves places and records to the context list', () => {
    const chips = [
      placeChip({ kind: 'inbox' }),
      recordChip('docs/spec.md', entries)!,
      fileChip('attachments/brief.docx'),
    ];
    expect(composerFiles(chips, []).map((file) => file.data.id)).toEqual([
      'file:attachments/brief.docx',
    ]);
  });

  it('draws a waiting file after the attached ones, with no path until it is copied in', () => {
    const files = composerFiles([fileChip('attachments/brief.docx')], [waiting()]);
    expect(files.map((file) => file.data.id)).toEqual(['file:attachments/brief.docx', 'pending:1']);
    const [, pending] = files;
    expect(pending.data.path).toBeUndefined();
    expect(pending.data.rootId).toBeUndefined();
    expect(pending.data.kind).toBe('pdf');
    expect(pending.state).toBe('idle');
    expect(pending.data.description).toBe(`PDF · ${FILE_WORDS.waiting}`);
  });

  it('says where each copy stands, and a refusal’s reason in words', () => {
    const [copying] = composerFiles([], [waiting({ state: 'copying' })]);
    expect(copying.state).toBe('uploading');
    expect(copying.data.description).toBe(FILE_WORDS.copying);
    const [failed] = composerFiles([], [waiting({ state: 'failed', reason: 'over 50 MB' })]);
    expect(failed.state).toBe('error');
    expect(failed.data.description).toBe('over 50 MB');
    const [unsaid] = composerFiles([], [waiting({ state: 'failed' })]);
    expect(unsaid.data.description).toBe(FILE_WORDS.failed);
  });

  it('has words for every kind the file-kinds table names', () => {
    for (const word of Object.values(KIND_WORDS)) expect(word.trim()).not.toBe('');
    expect(KIND_WORDS.pdf).toBe('PDF');
  });
});
