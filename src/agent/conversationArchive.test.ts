import { statusOf, chipOf } from '@/engine/ai/threadStatus';
import { afterEach, expect, it, vi } from 'vitest';
import {
  projectArchiveMessage,
  archiveConversation,
  healRetainedArchive,
  projectArchiveThread,
} from './conversationArchive';
import { checkedArchive } from './archiveContract';
import { expireArchivedMessages } from './archiveExpiry';
import { forgetArchivedConversation, loadConversations, saveConversations } from './conversations';
import type { ArchiveMessage, ArchiveThread } from '@/lib/generated/conversations';

export const record: ArchiveMessage = {
  attemptId: 'attempt',
  userMessageId: 'visible-question',
  assistantMessageId: 'visible-answer',
  origin: 'native_run',
  importedAt: null,
  runId: 'original-run',
  sessionId: null,
  completedAt: '2026-10-26T12:00:00Z',
  expiresAt: new Date(Date.now() + 2_592_000_000).toISOString(),
  contentState: 'retained',
  persistence: 'retained',
  content: {
    version: 1,
    displayMessage: {
      text: 'Original question',
      addressedLabel: null,
      attachmentRefs: ['notes/attached.md'],
    },
    completionStatus: 'completed',
    answer: {
      version: 1,
      availability: 'complete',
      references: [{ kind: 'source', toolId: 'lookup', url: 'https://example.com/' }],
      blocks: [
        { kind: 'text', messageId: 'narration', text: 'I will look.' },
        { kind: 'tool', toolId: 'lookup', name: 'WebFetch', state: 'completed' },
        { kind: 'text', messageId: 'answer', text: 'Final answer' },
      ],
    },
  },
};
export const thread: ArchiveThread = {
  id: 'thread',
  title: 'Original question',
  createdAt: '2026-10-26T12:00:00Z',
  updatedAt: '2026-10-26T12:00:00Z',
  titleExpiresAt: null,
  parentThreadId: null,
  branchMessageId: null,
  sessionId: null,
  contentState: 'retained',
};
afterEach(() => {
  window.localStorage.clear();
  vi.useRealTimers();
});
it('replays normalized content through the existing reducer with durable IDs and a distinct final answer', () => {
  const messages = projectArchiveMessage(record);
  expect(messages.map((message) => message.id)).toEqual(['visible-question', 'visible-answer']);
  expect(messages[0].text).toBe('Original question');
  expect(messages[1].text).toBe('Final answer');
  expect(messages[1].parts).toEqual(
    expect.arrayContaining([{ kind: 'text', id: expect.any(String), text: 'I will look.' }]),
  );
  expect(messages[1].tools[0]).toMatchObject({
    id: 'lookup',
    done: true,
    result: { type: 'web_fetch', url: 'https://example.com/' },
  });
  expect(messages[1].anchor).toBeUndefined();
  expect(JSON.stringify(messages)).not.toContain('reasoning');
});
it('rejects missing required nullable fields, raw payload extras, unknown versions and unknown shapes', () => {
  const page = (item: unknown) => ({
    context: { vaultId: 'v', storeUuid: 's' },
    threadId: 'thread',
    items: [item],
    nextCursor: null,
  });
  expect(checkedArchive('MessagePage', page(record))).toEqual(page(record));
  const { expiresAt: _missing, ...missing } = record;
  expect(() => checkedArchive('MessagePage', page(missing))).toThrow();
  expect(() =>
    checkedArchive('MessagePage', page({ ...record, content: { ...record.content, version: 2 } })),
  ).toThrow();
  expect(() =>
    checkedArchive(
      'MessagePage',
      page({
        ...record,
        content: { ...record.content, answer: { ...record.content!.answer, rawOutput: 'private' } },
      }),
    ),
  ).toThrow();
  expect(() =>
    checkedArchive('ThreadPage', {
      context: { vaultId: 'v', storeUuid: 's' },
      items: [],
      nextCursor: null,
      permission: true,
    }),
  ).toThrow();
});

it('never saves native-derived bodies or source titles to browser storage after readback', () => {
  const conversation = {
    ...archiveConversation(thread, '/vault'),
    messages: projectArchiveMessage(record),
  };
  saveConversations([conversation]);
  const raw = window.localStorage.getItem('cerebro.conversations')!;
  for (const value of ['Original question', 'Final answer', 'I will look.', 'https://example.com/'])
    expect(raw).not.toContain(value);
  expect(loadConversations()[0].messages.map((message) => message.id)).toEqual([
    'visible-question',
    'visible-answer',
  ]);
});
it('removes a committed deletion only from its known vault and leaves unknown legacy ownership intact', () => {
  const own = archiveConversation(thread, '/vault');
  const elsewhere = { ...own, id: 'other', vault: '/other' };
  const { vault: _vault, ...unknown } = own;
  saveConversations([own, elsewhere, { ...unknown, id: 'unknown' }]);
  forgetArchivedConversation('/vault', 'thread');
  expect(loadConversations().map((item) => item.id)).toEqual(['other', 'unknown']);
});
it('expires each original message without touching the newer live reply or retaining parts and references', () => {
  const retained = projectArchiveMessage(record);
  const live = {
    id: 'new-answer',
    role: 'assistant' as const,
    text: 'Working',
    tools: [],
    streaming: true,
  };
  const before = expireArchivedMessages([...retained, live], Date.parse(record.expiresAt!) - 1);
  expect(before[0]).toBe(retained[0]);
  const after = expireArchivedMessages([...retained, live], Date.parse(record.expiresAt!));
  expect(after[2]).toBe(live);
  expect(after[1].archiveRecord?.persistence).toBe('expired');
  expect(after[1].parts).toBeUndefined();
  expect(after[1].tools).toEqual([]);
  expect(JSON.stringify(after)).not.toContain('Final answer');
});
it('labels unavailable content without inventing an empty answer', () => {
  const unavailable = projectArchiveMessage({
    ...record,
    content: null,
    persistence: 'unavailable',
    contentState: 'metadata_only',
  });
  expect(unavailable).toHaveLength(1);
  expect(unavailable[0].text).toContain('unavailable');
});

it('never heals expired or metadata-only placeholders even when CLI ids and anchors match', () => {
  const placeholder = {
    id: 'same-id',
    role: 'assistant' as const,
    text: 'Expired placeholder',
    tools: [],
    archiveRecord: {
      attemptId: 'old',
      expiresAt: '2026-01-01T00:00:00Z',
      persistence: 'expired' as const,
    },
  };
  const cli = {
    ...placeholder,
    text: 'PRIVATE CLI BODY',
    parts: [{ kind: 'reasoning' as const, id: 'thinking', text: 'PRIVATE REASONING', done: true }],
  };
  expect(healRetainedArchive([placeholder], [cli])[0]).toBe(placeholder);
  const missing = {
    ...placeholder,
    archiveRecord: { ...placeholder.archiveRecord, persistence: 'unavailable' as const },
  };
  expect(healRetainedArchive([missing], [cli])[0]).toBe(missing);
});
it('preserves an explicit browser name separately from a generated archive title', () => {
  const named = {
    ...archiveConversation(thread, '/vault'),
    archiveTitle: undefined,
    title: 'My custom name',
  };
  saveConversations([named]);
  expect(loadConversations()[0].title).toBe('My custom name');
});

it('branches only from an actually recorded native anchor with that original attempt session', () => {
  const session = '33333333-3333-4333-8333-333333333333';
  const uuid = '44444444-4444-4444-8444-444444444444';
  const anchored = {
    ...record,
    sessionId: session,
    content: { ...record.content!, answer: { ...record.content!.answer, lastUuid: uuid } },
  };
  expect(projectArchiveMessage(anchored)[1].anchor).toEqual({ sessionId: session, uuid });
  expect(projectArchiveMessage({ ...anchored, sessionId: null })[1].anchor).toBeUndefined();
});

it('normalizes a native retained response that arrives after its original expiry before exposing any body', () => {
  const late = { ...record, expiresAt: new Date(Date.now() - 1).toISOString() };
  const projected = projectArchiveMessage(late);
  expect(JSON.stringify(projected)).not.toContain('Original question');
  expect(JSON.stringify(projected)).not.toContain('Final answer');
  expect(JSON.stringify(projected)).not.toContain('https://example.com/');
  expect(projected.every((message) => message.archiveRecord?.persistence === 'expired')).toBe(true);
});

it('normalizes a late native source title using its exact source expiry while preserving a separate browser custom name', () => {
  const source = { ...thread, titleExpiresAt: new Date(Date.now() - 1).toISOString() };
  expect(projectArchiveThread(source).title).toBeNull();
  expect(archiveConversation(source, '/vault').title).toBe('Conversation');
  const named = {
    ...archiveConversation(source, '/vault'),
    archiveTitle: undefined,
    title: 'User’s custom name',
  };
  saveConversations([named]);
  expect(loadConversations()[0].title).toBe('User’s custom name');
});

it('seals only imported presentation while original completion remains unrecorded and no successful run is invented', () => {
  const imported = {
    ...record,
    origin: 'browser_cache' as const,
    runId: null,
    sessionId: null,
    completedAt: null,
    importedAt: '2026-10-27T12:00:00Z',
    content: {
      ...record.content!,
      completionStatus: 'not_recorded',
      answer: { ...record.content!.answer, availability: 'partial' as const },
    },
  };
  const answer = projectArchiveMessage(imported)[1];
  expect(answer.text).toBe('Final answer');
  expect(answer.archiveRecord).toMatchObject({
    origin: 'browser_cache',
    completedAt: null,
    importedAt: '2026-10-27T12:00:00Z',
  });
  expect(answer.live).toBeUndefined();
  expect(answer.generationObservation).toBeUndefined();
  expect(answer.workedMs).toBeUndefined();
  const status = statusOf(
    {
      active: { streaming: answer.streaming === true, waiting: false },
      sessionId: imported.sessionId,
      liveRun: imported.runId,
    },
    { state: 'read', cards: [] },
  );
  expect(status).toBe('idle');
  expect(chipOf(status)).toBeNull();
});
