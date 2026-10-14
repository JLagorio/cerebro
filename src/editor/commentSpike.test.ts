// @vitest-environment jsdom
import { BlockNoteEditor, selectedFragmentToHTML } from '@blocknote/core';
import {
  CommentsExtension,
  DefaultThreadStoreAuth,
  ThreadStore,
  type CommentData,
  type ThreadData,
} from '@blocknote/core/comments';
import { undoDepth } from 'prosemirror-history';
import { TextSelection } from 'prosemirror-state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blocksToMarkdownNow, markdownToBlocksNow } from './markdown';
import { cerebroSchema, type CerebroEditor } from './MarkdownEditor';

/**
 * The M70.1 spike: BlockNote 0.46.2's own comments extension, measured.
 *
 * The rule was fixed before measuring: adopt CommentsExtension only if F2, F3
 * and F4 are all false. Each is true, so comments are drawn by
 * commentHighlights.ts as decorations, and no production file imports
 * `@blocknote/core/comments` (eslint.config.js holds that rail; this file is
 * its one exemption). A BlockNote bump that flips a fact fails it here, and
 * docs/superpowers/specs/2026-10-13-cerebro-m70-comments-spike-record.md says
 * what to revisit.
 */

/** Threads in memory: no Yjs, and no addThreadToDocument, so the extension
 * marks the selection itself. */
class MemoryThreadStore extends ThreadStore {
  // Declared, never defined: with no addThreadToDocument the extension marks
  // the selection itself, which is the path this spike measures.
  declare addThreadToDocument?: ThreadStore['addThreadToDocument'];
  private threads = new Map<string, ThreadData>();
  private subscribers = new Set<(threads: Map<string, ThreadData>) => void>();
  private next = 0;

  constructor() {
    super(new DefaultThreadStoreAuth('owner', 'editor'));
  }

  private emit() {
    for (const cb of this.subscribers) cb(new Map(this.threads));
  }

  private comment(body: unknown): CommentData {
    const now = new Date(0);
    return {
      type: 'comment',
      id: `c${++this.next}`,
      userId: 'owner',
      createdAt: now,
      updatedAt: now,
      reactions: [],
      metadata: {},
      body,
    };
  }

  async createThread(options: { initialComment: { body: unknown } }): Promise<ThreadData> {
    const now = new Date(0);
    const thread: ThreadData = {
      type: 'thread',
      id: `t${++this.next}`,
      createdAt: now,
      updatedAt: now,
      comments: [this.comment(options.initialComment.body)],
      resolved: false,
      metadata: {},
    };
    this.threads.set(thread.id, thread);
    this.emit();
    return thread;
  }

  async addComment(options: { comment: { body: unknown }; threadId: string }) {
    const added = this.comment(options.comment.body);
    this.getThread(options.threadId).comments.push(added);
    this.emit();
    return added;
  }

  async updateComment() {}
  async deleteComment() {}
  async deleteThread(options: { threadId: string }) {
    this.threads.delete(options.threadId);
    this.emit();
  }

  async resolveThread(options: { threadId: string }) {
    this.threads.set(options.threadId, { ...this.getThread(options.threadId), resolved: true });
    this.emit();
  }

  async unresolveThread(options: { threadId: string }) {
    this.threads.set(options.threadId, { ...this.getThread(options.threadId), resolved: false });
    this.emit();
  }

  async addReaction() {}
  async deleteReaction() {}

  getThread(threadId: string): ThreadData {
    const thread = this.threads.get(threadId);
    if (thread === undefined) throw new Error(`no thread ${threadId}`);
    return thread;
  }

  getThreads(): Map<string, ThreadData> {
    return new Map(this.threads);
  }

  subscribe(cb: (threads: Map<string, ThreadData>) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }
}

const PAGE = 'We ship on Thursdays, after the freeze.\n';
const QUOTE = 'after the freeze';

let editor: CerebroEditor;
let store: MemoryThreadStore;

beforeEach(() => {
  store = new MemoryThreadStore();
  editor = BlockNoteEditor.create({
    schema: cerebroSchema,
    extensions: [CommentsExtension({ threadStore: store, resolveUsers: async () => [] })],
  }) as unknown as CerebroEditor;
  const host = document.createElement('div');
  document.body.append(host);
  editor.mount(host);
  editor.replaceBlocks(editor.document, markdownToBlocksNow(editor, PAGE));
});

afterEach(() => {
  editor.unmount();
  document.body.replaceChildren();
});

const comments = () => editor.getExtension(CommentsExtension)!;

/** Select the quote, as a person would before commenting. */
function selectQuote() {
  let from = -1;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (from < 0 && node.isText && (node.text ?? '').includes(QUOTE)) {
      from = pos + (node.text ?? '').indexOf(QUOTE);
    }
    return from < 0;
  });
  editor.transact((tr) => tr.setSelection(TextSelection.create(tr.doc, from, from + QUOTE.length)));
}

/** Every comment mark in the doc, as its thread id and orphan flag. */
function marks(): { threadId: string; orphan: boolean }[] {
  const found: { threadId: string; orphan: boolean }[] = [];
  editor.prosemirrorState.doc.descendants((node) => {
    for (const mark of node.marks) {
      if (mark.type.name === 'comment') {
        found.push({ threadId: mark.attrs.threadId, orphan: mark.attrs.orphan });
      }
    }
    return true;
  });
  return found;
}

async function startThread() {
  selectQuote();
  await comments().createThread({ initialComment: { body: 'Is the freeze fixed?' } });
  const [thread] = store.getThreads().values();
  return thread;
}

describe('BlockNote 0.46.2 CommentsExtension, measured (M70.1)', () => {
  it('F1 upstream marks are blocknoteIgnore, so markdown export skips them', async () => {
    const before = blocksToMarkdownNow(editor);
    await startThread();
    expect(marks()).toHaveLength(1);
    expect(editor.prosemirrorState.schema.marks.comment.spec.blocknoteIgnore).toBe(true);
    expect(blocksToMarkdownNow(editor)).toBe(before);
  });

  it('F2 creating a thread adds an undo step, and undo removes the mark', async () => {
    const depth = undoDepth(editor.prosemirrorState);
    await startThread();
    expect(undoDepth(editor.prosemirrorState)).toBe(depth + 1);
    editor.undo();
    expect(marks()).toEqual([]);
  });

  it('F3 resolving flips orphan in a doc-changing transaction that adds an undo step and fires onChange', async () => {
    const thread = await startThread();
    const depth = undoDepth(editor.prosemirrorState);
    const doc = editor.prosemirrorState.doc;
    const onChange = vi.fn();
    editor.onChange(onChange);
    await store.resolveThread({ threadId: thread.id });
    expect(marks()).toEqual([{ threadId: thread.id, orphan: true }]);
    expect(editor.prosemirrorState.doc).not.toBe(doc);
    expect(undoDepth(editor.prosemirrorState)).toBe(depth + 1);
    expect(onChange).toHaveBeenCalled();
  });

  it("F4 a commented span's clipboard HTML carries data-bn-thread-id", async () => {
    const thread = await startThread();
    selectQuote();
    const { clipboardHTML } = selectedFragmentToHTML(editor.prosemirrorView!, editor);
    expect(clipboardHTML).toContain(`data-bn-thread-id="${thread.id}"`);
  });

  it('F5 the extension runs on a ThreadStore with no Yjs', async () => {
    expect('addThreadToDocument' in store).toBe(false);
    const thread = await startThread();
    expect(marks()).toEqual([{ threadId: thread.id, orphan: false }]);
    expect(thread.comments[0].body).toBe('Is the freeze fixed?');
  });
});
