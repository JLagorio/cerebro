/**
 * The person's own page opens, per vault (M59.3).
 *
 * It ranks ⌘K and the name pickers by use: a page you opened twice today
 * leads one you opened twenty times two months ago, inside one match tier
 * (`src/lib/nameRank.ts` keeps the tiers first). It is navigation state, like
 * favorites and the back stack: an agent's opens never count, and the log
 * never reaches a prompt, a tool, policy or the vault.
 *
 * Pure: the store (`src/stores/openLogStore.ts`) owns persistence and passes
 * `now` in.
 */

/** One page's opens. */
export interface OpenRecord {
  path: string;
  /** Epoch ms, newest first, at most `OPEN_LOG_TIMES` of them. */
  opens: number[];
  /** Every open ever recorded, kept or trimmed. Shown, never ranked. */
  count: number;
}

/** Most recently opened first, at most `OPEN_LOG_PAGES` records. */
export type OpenLog = OpenRecord[];

export const OPEN_LOG_PAGES = 200;
export const OPEN_LOG_TIMES = 10;
/** Under it, 20 opens 60 days ago weigh about 0.03, against 2.0 for two today. */
export const OPEN_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

const newestFirst = (a: number, b: number) => b - a;

/** Move `path` to the front with one more open at `now`, then trim both caps. */
export function recordOpen(log: OpenLog, path: string, now: number): OpenLog {
  const prior = log.find((r) => r.path === path);
  const record: OpenRecord = {
    path,
    opens: [now, ...(prior?.opens ?? [])].sort(newestFirst).slice(0, OPEN_LOG_TIMES),
    count: (prior?.count ?? 0) + 1,
  };
  return [record, ...log.filter((r) => r.path !== path)].slice(0, OPEN_LOG_PAGES);
}

/**
 * Follow a rename: `from` and everything beneath it (`from/…`) move to `to`,
 * navStore's `replacePath` rule. A record that lands on a path the log
 * already holds merges into it, at the earlier position: times newest first
 * and capped, counts summed.
 */
export function remapOpens(log: OpenLog, from: string, to: string): OpenLog {
  if (from === to) return log;
  const swap = (p: string): string => {
    if (p === from) return to;
    if (p.startsWith(`${from}/`)) return `${to}${p.slice(from.length)}`;
    return p;
  };
  const out: OpenLog = [];
  const at = new Map<string, number>();
  for (const record of log) {
    const path = swap(record.path);
    const seen = at.get(path);
    if (seen === undefined) {
      at.set(path, out.length);
      out.push(path === record.path ? record : { ...record, path });
      continue;
    }
    const kept = out[seen];
    out[seen] = {
      path,
      opens: [...kept.opens, ...record.opens].sort(newestFirst).slice(0, OPEN_LOG_TIMES),
      count: kept.count + record.count,
    };
  }
  return out;
}

/** Keep only the records whose page still exists. */
export function pruneOpens(log: OpenLog, exists: (path: string) => boolean): OpenLog {
  const kept = log.filter((r) => exists(r.path));
  return kept.length === log.length ? log : kept;
}

/** Drop one page's record. */
export function forgetOpen(log: OpenLog, path: string): OpenLog {
  return log.filter((r) => r.path !== path);
}

/**
 * How much a record's opens weigh at `now`: each kept open counts
 * 2^(−age / half-life). A time in the future (a clock that moved back) counts
 * as age 0, never as more than one open.
 */
export function openWeight(record: OpenRecord, now: number): number {
  let weight = 0;
  for (const t of record.opens) {
    weight += 2 ** (-Math.max(0, now - t) / OPEN_HALF_LIFE_MS);
  }
  return weight;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function readRecord(raw: unknown): OpenRecord | null {
  if (!isObject(raw) || typeof raw.path !== 'string' || raw.path === '') return null;
  const opens = (Array.isArray(raw.opens) ? raw.opens : [])
    .filter((t): t is number => typeof t === 'number' && Number.isFinite(t))
    .sort(newestFirst)
    .slice(0, OPEN_LOG_TIMES);
  if (opens.length === 0) return null;
  const count =
    typeof raw.count === 'number' && Number.isFinite(raw.count) ? Math.floor(raw.count) : 0;
  return { path: raw.path, opens, count: Math.max(count, opens.length) };
}

function readLog(raw: unknown): OpenLog {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: OpenLog = [];
  for (const item of raw) {
    const record = readRecord(item);
    if (record === null || seen.has(record.path)) continue;
    seen.add(record.path);
    out.push(record);
    if (out.length === OPEN_LOG_PAGES) break;
  }
  return out;
}

/**
 * Narrow untrusted JSON (localStorage) to `{vault: OpenLog}`. Anything else —
 * a flat array, a string, a record with no times — reads as nothing rather
 * than as a guess.
 */
export function readOpenLogs(raw: unknown): Record<string, OpenLog> {
  if (!isObject(raw)) return {};
  const out: Record<string, OpenLog> = {};
  for (const [vault, value] of Object.entries(raw)) {
    const log = readLog(value);
    if (log.length > 0) out[vault] = log;
  }
  return out;
}
