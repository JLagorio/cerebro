import { describe, expect, it } from 'vitest';
import CASES from '../../src-tauri/fixtures/comment-cases.json';
import {
  applyCommentOp,
  COMMENT_LIMITS,
  COMMENTS_DIR,
  COMMENTS_FORMAT,
  emptyComments,
  fileFromValue,
  openThreadCount,
  OWNER,
  pageOfSidecar,
  parseComments,
  serializeComments,
  sidecarFolderOf,
  sidecarPathOf,
  sizeRefusal,
  visibleThreads,
  type CommentOp,
  type CommentOpContext,
  type CommentsFile,
} from './comments';

/** A fixture file object, read through the same shape check Rust uses. */
function fileOf(value: unknown): CommentsFile {
  const parsed = fileFromValue(value);
  if (!parsed.ok) throw new Error(`fixture file is ${parsed.reason} at ${parsed.pointer}`);
  return parsed.file;
}

/** A file as plain JSON, so absent keys compare as absent. */
const plain = (file: CommentsFile): unknown => JSON.parse(serializeComments(file));

describe('page comments (M70.2)', () => {
  it('the limits equal the fixture', () => {
    expect(CASES.limits).toEqual({
      dir: COMMENTS_DIR,
      format: COMMENTS_FORMAT,
      body: COMMENT_LIMITS.body,
      quote: COMMENT_LIMITS.quote,
      context: COMMENT_LIMITS.context,
      file_bytes: COMMENT_LIMITS.fileBytes,
      owner: OWNER,
    });
  });

  it('replays the shared comment cases', () => {
    for (const row of CASES.paths as unknown as Record<string, string | null>[]) {
      if (typeof row.folder === 'string') {
        expect(sidecarFolderOf(row.folder), row.folder).toBe(row.sidecar_folder);
        continue;
      }
      const sidecar = row.sidecar as string;
      if (typeof row.page === 'string') {
        expect(sidecarPathOf(row.page), sidecar).toBe(sidecar);
        expect(pageOfSidecar(sidecar), sidecar).toBe(row.page);
      } else {
        expect(pageOfSidecar(sidecar), sidecar).toBeNull();
      }
    }
    for (const row of CASES.parse as unknown as {
      name: string;
      text: string;
      file?: unknown;
      reason?: string;
    }[]) {
      const parsed = parseComments(row.text);
      if (row.reason !== undefined) {
        expect(parsed.ok ? 'parsed' : parsed.reason, row.name).toBe(row.reason);
      } else {
        expect(parsed.ok, row.name).toBe(true);
        if (parsed.ok) expect(plain(parsed.file), row.name).toEqual(row.file);
      }
    }
    for (const row of CASES.ops as unknown as {
      name: string;
      before: unknown;
      op: CommentOp;
      ctx: CommentOpContext;
      after: unknown;
    }[]) {
      const before = row.before === null ? emptyComments() : fileOf(row.before);
      const snapshot = serializeComments(before);
      const outcome = applyCommentOp(before, row.op, row.ctx);
      expect(serializeComments(before), `${row.name}: the input is untouched`).toBe(snapshot);
      if (row.after === 'unchanged') {
        expect(outcome, row.name).toEqual({ ok: true, file: null });
      } else if (typeof row.after === 'object' && row.after !== null && 'error' in row.after) {
        expect(outcome, row.name).toEqual({ ok: false, error: row.after.error });
      } else {
        expect(outcome.ok && outcome.file !== null, row.name).toBe(true);
        if (outcome.ok && outcome.file !== null) {
          expect(plain(outcome.file), row.name).toEqual(row.after);
          // Every file an op writes reads back as itself.
          expect(parseComments(serializeComments(outcome.file)), row.name).toEqual({
            ok: true,
            file: outcome.file,
          });
        }
      }
    }
    for (const row of CASES.bytes as unknown as { name: string; file: unknown; text: string }[]) {
      expect(serializeComments(fileOf(row.file)), row.name).toBe(row.text);
    }
  });

  it('path mapping round-trips, folders included', () => {
    for (const page of ['a.md', 'notes/plan.md', 'records/decisions/dec-1.md']) {
      expect(pageOfSidecar(sidecarPathOf(page))).toBe(page);
    }
    const folder = sidecarFolderOf('records/decisions');
    expect(pageOfSidecar(`${folder}/dec-1.md.json`)).toBe('records/decisions/dec-1.md');
    expect(pageOfSidecar(folder)).toBeNull();
  });

  const comment = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    author: OWNER,
    created: '2026-10-14T09:00:00Z',
    body: 'x',
    ...extra,
  });
  const stamp = { at: '2026-10-14T09:00:00Z', by: OWNER };

  it('visibleThreads leaves deleted threads out, and openThreadCount leaves resolved ones out too', () => {
    const file = fileOf({
      format: 1,
      threads: [
        { comments: [comment('0000000000000001')] },
        { resolved: stamp, comments: [comment('0000000000000002')] },
        {
          deleted: stamp,
          comments: [comment('0000000000000003', { body: '', deleted: stamp })],
        },
        {
          comments: [
            comment('0000000000000004', { body: '', deleted: stamp }),
            comment('0000000000000005'),
          ],
        },
      ],
    });
    expect(visibleThreads(file).map((v) => v.id)).toEqual([
      '0000000000000001',
      '0000000000000002',
      '0000000000000004',
    ]);
    expect(openThreadCount(file)).toBe(2);
    expect(openThreadCount(emptyComments())).toBe(0);
  });

  it('a file past 1 MiB is refused, counted in UTF-8 bytes', () => {
    const threads = [];
    // 100 comments of 3,500 three-byte characters: about 1.05 MB in UTF-8,
    // though fewer than 400,000 UTF-16 units.
    for (let n = 0; n < 100; n += 1) {
      threads.push({
        comments: [comment(n.toString(16).padStart(16, '0'), { body: '€'.repeat(3500) })],
      });
    }
    const text = serializeComments(fileOf({ format: 1, threads }));
    expect(text.length).toBeLessThan(COMMENT_LIMITS.fileBytes);
    expect(sizeRefusal('notes/plan.md', text)).toBe(
      'Comments for notes/plan.md would pass 1 MiB, so nothing was written.',
    );
    expect(sizeRefusal('notes/plan.md', serializeComments(emptyComments()))).toBeNull();
  });
});
