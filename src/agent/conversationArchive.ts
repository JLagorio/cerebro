import { expireArchivedMessages } from './archiveExpiry';
import type {
  ArchiveContext,
  ArchiveMessage,
  ArchiveSetting,
  ArchiveThread,
  DeleteResult,
  ExportFormat,
  ExportResult,
  MessagePage,
  PruneResult,
  RetentionChoice,
  ThreadPage,
  ImportBatch,
  ImportResult,
} from '@/lib/generated/conversations';
import type { AgentStreamEvent, ChatMessage, Conversation } from './types';
import { healFromTranscript, replayTranscript } from './transcript';
import * as ipc from './agentIpc';

export interface ArchiveService {
  context(): Promise<ArchiveContext>;
  import(context: ArchiveContext, batch: ImportBatch): Promise<ImportResult>;
  setting(context: ArchiveContext): Promise<ArchiveSetting>;
  choose(
    context: ArchiveContext,
    choice: RetentionChoice,
    revision: number,
  ): Promise<ArchiveSetting>;
  threads(context: ArchiveContext, query: string, after?: string | null): Promise<ThreadPage>;
  messages(context: ArchiveContext, thread: string, before?: string | null): Promise<MessagePage>;
  remove(context: ArchiveContext, thread: string): Promise<DeleteResult>;
  prune(context: ArchiveContext): Promise<PruneResult>;
  export(context: ArchiveContext, thread: string, format: ExportFormat): Promise<ExportResult>;
}
export const archiveService: ArchiveService = {
  context: (...args) => ipc.archiveContext(...args),
  import: (...args) => ipc.importCachedConversation(...args),
  setting: (...args) => ipc.archiveSetting(...args),
  choose: (...args) => ipc.setArchiveRetention(...args),
  threads: (...args) => ipc.archiveThreads(...args),
  messages: (...args) => ipc.archiveMessages(...args),
  remove: (...args) => ipc.deleteArchivedThread(...args),
  prune: (...args) => ipc.pruneArchive(...args),
  export: (...args) => ipc.exportArchivedThread(...args),
};
export function sameArchiveContext(a: ArchiveContext, b: ArchiveContext): boolean {
  return a.vaultId === b.vaultId && a.storeUuid === b.storeUuid;
}

/** Local visibility at the original recorded boundary, independent of another read. */
export function currentArchiveRecord(record: ArchiveMessage): ArchiveMessage {
  return record.persistence === 'retained' &&
    record.expiresAt !== null &&
    Date.parse(record.expiresAt) <= Date.now()
    ? { ...record, content: null, persistence: 'expired', contentState: 'expired' }
    : record;
}

/** Feed the existing transcript reducer. No second message renderer/reducer. */
export function projectArchiveMessage(record: ArchiveMessage): ChatMessage[] {
  const current = currentArchiveRecord(record);
  if (current !== record) return projectArchiveMessage(current);
  const retained = record.content;
  const marker = {
    attemptId: record.attemptId,
    expiresAt: record.expiresAt,
    persistence: record.persistence,
    origin: record.origin,
    importedAt: record.importedAt,
    completedAt: record.completedAt,
  };
  if (retained === null) {
    return [
      {
        id: record.assistantMessageId,
        role: 'assistant',
        tools: [],
        archiveRecord: marker,
        text:
          record.persistence === 'unavailable'
            ? 'Archived content is unavailable.'
            : record.contentState === 'expired'
              ? 'This message’s archived content expired.'
              : 'This message was not retained.',
      },
    ];
  }
  const events: AgentStreamEvent[] = [{ kind: 'UserPrompt', text: retained.displayMessage.text }];
  for (const block of retained.answer.blocks) {
    if (block.kind === 'text')
      events.push({ kind: 'Text', message_id: block.messageId, text: block.text });
    else if (block.kind === 'tool') {
      events.push({ kind: 'ToolStart', tool_id: block.toolId, tool_name: block.name });
      if (block.state === 'deferred')
        events.push({ kind: 'ToolDeferred', tool_id: block.toolId, tool_name: block.name });
      else if (block.state !== 'running') {
        if (block.state === 'denied')
          events.push({
            kind: 'ToolDenied',
            tool_id: block.toolId,
            tool_name: block.name,
            message: 'The call was denied.',
          });
        events.push({
          kind: 'ToolDone',
          tool_id: block.toolId,
          is_error: block.state !== 'completed',
        });
      }
    } else
      events.push({
        kind: 'ToolResult',
        tool_id: block.toolId,
        data: { type: 'agent', summary: block.summary },
      });
  }
  for (const reference of retained.answer.references) {
    if (reference.kind === 'source')
      events.push({
        kind: 'ToolResult',
        tool_id: reference.toolId,
        data: { type: 'web_fetch', url: reference.url },
      });
  }
  // Close only the display reducer's final text; no Result/outcome/usage is invented.
  // Browser-cache origin and original completion metadata remain explicit below.
  if (
    retained.completionStatus === 'completed' ||
    (record.origin === 'browser_cache' && retained.completionStatus === 'not_recorded')
  )
    events.push({
      kind: 'TurnEnded',
      ...(retained.answer.lastUuid == null ? {} : { last_uuid: retained.answer.lastUuid }),
    });
  if (retained.completionStatus === 'cancelled') events.push({ kind: 'Cancelled' });
  if (retained.completionStatus === 'failed' || retained.completionStatus === 'interrupted')
    events.push({ kind: 'TurnInterrupted', reason: 'cut_off' });
  const replayed = replayTranscript(events, record.sessionId ?? '').messages;
  return expireArchivedMessages(
    replayed.map((message) => ({
      ...message,
      id: message.role === 'user' ? record.userMessageId : record.assistantMessageId,
      streaming: false,
      archiveRecord: marker,
      ...(message.role === 'user'
        ? {
            archiveAttachmentRefs: retained.displayMessage.attachmentRefs,
            ...(retained.displayMessage.addressedLabel === null
              ? {}
              : { addressed: { handle: '', title: retained.displayMessage.addressedLabel } }),
          }
        : {}),
    })),
    Date.now(),
  );
}

/** The expiry belongs to the exact native source title. Browser names have their own owner. */
export function projectArchiveThread(thread: ArchiveThread): ArchiveThread {
  const expiry = 'titleExpiresAt' in thread ? thread.titleExpiresAt : null;
  return typeof expiry === 'string' && Date.parse(expiry) <= Date.now()
    ? { ...thread, title: null }
    : thread;
}

export function archiveConversation(thread: ArchiveThread, vault: string): Conversation {
  return {
    id: thread.id,
    title: projectArchiveThread(thread).title ?? 'Conversation',
    usesDefaultTitle: true,
    sessionId: thread.sessionId,
    messages: [],
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    vault,
    archived: false,
    place: null,
    archiveBacked: true,
    archiveTitle: true,
    archiveTitleExpiresAt:
      'titleExpiresAt' in thread && typeof thread.titleExpiresAt === 'string'
        ? thread.titleExpiresAt
        : null,
    archiveAncestry:
      thread.parentThreadId !== null && thread.branchMessageId !== null
        ? { parentThreadId: thread.parentThreadId, branchMessageId: thread.branchMessageId }
        : null,
  };
}

/** Native placeholders never recover content by matching a CLI id or anchor. */
export function healRetainedArchive(
  cached: ChatMessage[],
  rebuilt: ChatMessage[],
  now = Date.now(),
): ChatMessage[] {
  const safe = expireArchivedMessages(cached, now);
  const eligible = safe.filter(
    (message) =>
      message.archiveRecord?.persistence === 'retained' &&
      (message.archiveRecord.expiresAt === null ||
        Date.parse(message.archiveRecord.expiresAt) > now),
  );
  const healed = healFromTranscript(eligible, rebuilt);
  const byId = new Map(healed.map((message) => [message.id, message]));
  return safe.map((message) => byId.get(message.id) ?? message);
}
