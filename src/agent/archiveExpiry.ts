import type { ChatMessage } from './types';

export function nextArchiveExpiry(messages: readonly ChatMessage[], now: number): number | null {
  const values = messages.flatMap((message) => {
    const record = message.archiveRecord;
    if (record?.persistence !== 'retained' || record.expiresAt === null) return [];
    const at = Date.parse(record.expiresAt);return Number.isFinite(at) ? [Math.max(now,at)] : [];
  });
  return values.length === 0 ? null : Math.min(...values);
}
/** Hide only expired native-derived content. Live run state belongs to other messages. */
export function expireArchivedMessages(messages: ChatMessage[], now: number): ChatMessage[] {
  let changed = false;
  const next = messages.map((message) => {
    const record = message.archiveRecord;
    if (record?.persistence !== 'retained' || record.expiresAt === null || Date.parse(record.expiresAt) > now) return message;
    changed = true;
    return {id:message.id,role:message.role,text:'This message’s archived content expired.',tools:[],archiveRecord:{...record,persistence:'expired' as const}};
  });
  return changed ? next : messages;
}
