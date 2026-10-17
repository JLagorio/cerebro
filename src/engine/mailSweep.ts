/** An attended header reader and a human retention plan. Neither runs itself. */
import type { Entry } from './types';
import type { ConnectorStatusRow } from './connectors';
import { dateEpoch, isDateText } from './dateGrammar';
import { LIBRARY_FOLDER } from './library';
import { MAIL, isMailPath } from './mailPolicy';
import { MAX_BATCH_OPS, type BatchOp } from './batch';
export const MAIL_SWEEP_PATH = `${LIBRARY_FOLDER.agent}/mail-sweep.md`;
const TOOL_PART = /^[A-Za-z0-9_-]{1,64}$/;
const thread = (entry: Entry) =>
  isMailPath(entry.path) && entry.properties.source_kind === MAIL.kinds.thread;
const readable = (entry: Entry) => entry.parseError === null && entry.hash !== null;
export function newestMailFetch(entries: Entry[]): string | null {
  const times = entries
    .filter((entry) => thread(entry) && readable(entry))
    .map((entry) => entry.properties.fetched_at)
    .filter((value): value is string => typeof value === 'string' && dateEpoch(value) !== null);
  return times.sort((a, b) => dateEpoch(b)! - dateEpoch(a)!)[0] ?? null;
}
export function sweepStatus(entries: Entry[], connector: ConnectorStatusRow | null): string {
  const fetched = newestMailFetch(entries);
  const status = connector?.refused
    ? 'denied'
    : connector?.state === 'needs_sign_in'
      ? 'needs sign-in'
      : connector?.state === 'not_approved'
        ? 'denied'
        : connector?.state === 'failed'
          ? 'unreachable'
          : connector?.state === 'working'
            ? 'connector working'
            : 'not checked yet';
  return `${fetched === null ? 'Never swept' : `As of ${fetched}`} · ${status}`;
}
export function sweepAgentDraft(connector: string, cliName = connector) {
  if (!TOOL_PART.test(cliName)) throw new Error('Choose a connector with a valid tool name.');
  const qualified = (tool: string) => `mcp__${cliName}__${tool}`;
  const reads = MAIL.sweep.read_tools.map(qualified);
  return {
    folder: LIBRARY_FOLDER.agent,
    slug: 'mail-sweep',
    frontmatter: {
      type: 'Agent',
      slug: 'mail-sweep',
      title: 'Mail sweep',
      paused: true,
      tools: 'safe',
      scope: [],
      'read-scope': [MAIL.folder],
      connectors: [connector],
      'allowed-tools': ['search_notes', 'get_note', 'list_notes', 'cache_source', ...reads],
      'disallowed-tools': MAIL.sweep.denied_tools.map(qualified),
    },
    body: `# Mail sweep\n\nCache recent mail headers when the person asks you here. Never run on a schedule. If this connector is missing or refuses a call, say so and stop. Never use another connector or a shell fallback.\n\nUse list_notes, search_notes and get_note only under ${MAIL.folder}. Find the newest valid fetched_at, subtract one day and use after:YYYY/MM/DD. If no valid fetch time is recorded, use newer_than:${MAIL.sweep.window_days}d. A missing or unreadable cache is not proof the mailbox is empty.\n\nSearch with ${qualified('search_threads')}: append -category:promotions -category:social -category:updates -category:forums to that window. Use view: THREAD_VIEW_MINIMAL, pageSize: ${MAIL.sweep.page_size}, includeTrash: false. Repeat the same window and exclusions with in:sent. Follow page tokens only up to ${MAIL.sweep.max_threads} distinct threads across both searches, and deduplicate by thread id. Never store snippets.\n\nSkip a thread only when its cached digest already holds the newest message id returned by the connector. For another thread use ${qualified('get_thread')} with messageFormat: METADATA_ONLY, never full message text. Then cache_source kind ${MAIL.kinds.thread}: id is the thread id; title is the returned subject; each message includes its id, from (sender), to (toRecipients), cc (ccRecipients), date and labels (labelIds), exactly as returned. Leave out drafts and bcc. Never pass body, snippet, attachments or HTML. Never invent a missing label or date; report that thread as refused.\n\nReport cached, skipped and refused counts, and whether the thread limit left more to fetch. Say every connector refusal or failed read. No writes besides cache_source; never draft, send, label, trash or mark spam.\n`,
  };
}
export interface MailPrunePlan {
  ops: BatchOp[];
  digests: number;
  textPages: number;
  undated: number;
  unreadable: number;
  remaining: number;
  keptText: number;
}
/** A digest/text pair is indivisible at the operation cap. Hashes freeze the
 * preview: a refresh or human save refuses the whole batch instead of deleting
 * newer material. Undated and unreadable pages remain in place. */
export function pruneCandidates(
  entries: Entry[],
  cutoffDay: string,
  cap = MAX_BATCH_OPS,
): MailPrunePlan {
  const result: MailPrunePlan = {
    ops: [],
    digests: 0,
    textPages: 0,
    undated: 0,
    unreadable: 0,
    remaining: 0,
    keptText: 0,
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoffDay) || !isDateText(cutoffDay)) return result;
  const cutoff = dateEpoch(`${cutoffDay}T00:00:00Z`)!;
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const dated: { entry: Entry; time: number }[] = [];
  for (const entry of entries.filter((entry) => isMailPath(entry.path))) {
    if (!readable(entry)) {
      result.unreadable++;
      continue;
    }
    if (!thread(entry)) continue;
    const raw = entry.properties.last_message_at;
    const time = typeof raw === 'string' ? dateEpoch(raw) : null;
    if (time === null) {
      result.undated++;
      continue;
    }
    if (time < cutoff) dated.push({ entry, time });
  }
  dated.sort((a, b) => a.time - b.time || a.entry.path.localeCompare(b.entry.path));
  for (const { entry } of dated) {
    const text = byPath.get(entry.path.replace(/\.md$/i, '-text.md'));
    const paired =
      text !== undefined &&
      readable(text) &&
      text.properties.source_kind === MAIL.kinds.text &&
      typeof entry.properties.source_id === 'string' &&
      text.properties.source_id === entry.properties.source_id;
    if (text !== undefined && !paired) result.keptText++;
    const group = paired ? [entry, text] : [entry];
    if (result.ops.length + group.length > Math.min(MAX_BATCH_OPS, Math.max(0, cap))) {
      result.remaining++;
      continue;
    }
    for (const page of group)
      result.ops.push({ op: 'delete', path: page.path, expectHash: page.hash! });
    result.digests++;
    if (paired) result.textPages++;
  }
  return result;
}
