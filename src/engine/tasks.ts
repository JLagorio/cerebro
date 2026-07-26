/**
 * Doc-task parsing (M2.x docs polish). Tasks live in note bodies as plain
 * markdown checklist items — the file stays readable everywhere:
 *
 *   - [ ] Draft the rollout plan 📅 2026-07-30 @[[maya-chen]]
 *
 * `📅 YYYY-MM-DD` is the due date (Obsidian-Tasks-compatible) and
 * `@[[person]]` assigns the task to a person note. The editor renders both
 * as chips; this module is the plain-text side used by the Home tasks
 * rollup and by tests.
 */

export interface DocTask {
  sourcePath: string;
  /** Index into body.split('\n') — used to toggle the checkbox in place. */
  line: number;
  /** Display text with due/assignee tokens stripped and wikilinks unwrapped. */
  text: string;
  done: boolean;
  due: string | null; // YYYY-MM-DD
  assignees: string[]; // wikilink targets from @[[target]]
}

const TASK_LINE = /^(\s*)[-*+] \[( |x|X)\] (.*)$/;
const DUE_TOKEN = /📅\s*(\d{4}-\d{2}-\d{2})/g;
const ASSIGNEE_TOKEN = /@\[\[([^\]|[]+)(?:\|[^\][]*)?\]\]/g;
const WIKILINK_TOKEN = /\[\[([^\]|[]+)(?:\|([^\][]*))?\]\]/g;

/** Parse every checklist item in a note body. Fenced code is skipped. */
export function parseTasks(sourcePath: string, body: string): DocTask[] {
  const tasks: DocTask[] = [];
  let inFence = false;
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = TASK_LINE.exec(line);
    if (match === null) continue;
    const raw = match[3];

    const due = [...raw.matchAll(DUE_TOKEN)].map((m) => m[1])[0] ?? null;
    const assignees = [...raw.matchAll(ASSIGNEE_TOKEN)].map((m) => m[1].trim());

    const text = raw
      .replace(DUE_TOKEN, '')
      .replace(ASSIGNEE_TOKEN, '')
      // Unwrap remaining wikilinks to their display text.
      .replace(WIKILINK_TOKEN, (_, target: string, alias?: string) => alias ?? target)
      .replace(/\s+/g, ' ')
      .trim();

    tasks.push({
      sourcePath,
      line: i,
      text,
      done: match[2] !== ' ',
      due,
      assignees,
    });
  }
  return tasks;
}

/**
 * Flip the checkbox on `line`. Returns the new body, or null when the line
 * is no longer a checklist item (stale index after an edit — caller should
 * refresh instead of writing).
 */
export function toggleTaskLine(body: string, line: number, done: boolean): string | null {
  const lines = body.split('\n');
  if (line < 0 || line >= lines.length) return null;
  const match = TASK_LINE.exec(lines[line]);
  if (match === null) return null;
  const box = done ? '[x]' : '[ ]';
  lines[line] = lines[line].replace(/\[( |x|X)\]/, box);
  return lines.join('\n');
}

export type DueBucket = 'overdue' | 'today' | 'upcoming' | 'none';

/** Bucket a due date against `today` (YYYY-MM-DD). */
export function dueBucket(due: string | null, today: string): DueBucket {
  if (due === null) return 'none';
  if (due < today) return 'overdue';
  if (due === today) return 'today';
  return 'upcoming';
}

/** 'YYYY-MM-DD' → 'Jul 30' (UTC-safe: no Date parsing of bare dates). */
export function formatDue(due: string): string {
  const [, m, d] = due.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[Number(m) - 1] ?? m;
  return `${month} ${Number(d)}`;
}
