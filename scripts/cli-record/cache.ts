// Resumed-turn cache writes (M56.12), measured. Pure: no file, no clock.
//
// Each attended turn's --append-system-prompt carries where the person is
// standing and the context snapshot, and both change as they move. A resumed
// turn whose prompt changed may write its whole cached prefix again; one whose
// prompt held should read it. The meter's per-run sums hide which, because a
// run's later calls re-read what its first call wrote, so this reads the
// session file, where every assistant line carries its own call's usage.
//
// Two gates decide whether the volatile context moves into the user message:
// the field (the owner's own Cerebro sessions, cache-report.ts) and, only when
// the field says the prefix is being rewritten, an A/B on the pinned CLI
// (cache-ab.ts). `gate` names the threshold that failed.

type JsonObject = Record<string, unknown>;

export const FIVE_MINUTES_MS = 5 * 60_000;
export const ONE_HOUR_MS = 60 * 60_000;
/** Gate 1: fewer warm resumed turns than this keeps (Q28). */
export const MIN_WARM_TURNS = 20;
/** Gate 1: a median warm first-call write share at or below this keeps. */
export const WRITE_SHARE_LIMIT = 0.5;
/** Gate 2: B's cost over turns 2-6 must be at most this share of A's. */
export const COST_RATIO_LIMIT = 0.8;
/** Gate 2: B's final prompt must be at most this many times A's. */
export const PROMPT_RATIO_LIMIT = 1.5;
/** The model Claude Code names on a reply no model wrote. */
const SYNTHETIC_MODEL = '<synthetic>';

/** One call's input-side usage. A bucket Claude Code did not report is null. */
export interface CallUsage {
  input: number;
  creation: number;
  read: number;
  fiveMinute: number | null;
  oneHour: number | null;
}

export interface ResumedTurn {
  /** 1-based; a resumed turn is 2 or more. */
  turn: number;
  /** From the last call before this turn to this turn's prompt; null when
   * either has no timestamp, or no call came before. */
  gapMs: number | null;
  /** The TTL the entries this turn could hit were written with. */
  ttlMs: number;
  /** Null exactly when gapMs is. */
  warm: boolean | null;
  /** Null when the turn made no metered call (CV-05: unmetered, never zero). */
  firstCall: CallUsage | null;
  /** creation / (creation + read); null when unmetered or nothing was cached. */
  share: number | null;
}

export interface SessionStats {
  turns: number;
  resumed: ResumedTurn[];
}

export interface FieldSummary {
  sessions: number;
  turns: number;
  resumed: number;
  /** Resumed turns with no metered call. */
  unmetered: number;
  /** Metered, but with no gap to judge warmth by. */
  untimed: number;
  /** Metered and timed, but neither writing nor reading the cache. */
  uncached: number;
  warm: number;
  cold: number;
  warmShare: { median: number | null; p90: number | null };
  coldShare: { median: number | null };
}

export type Decision =
  | { decision: 'move'; gate: 'ab'; reasons: string[] }
  | { decision: 'keep'; gate: 'field' | 'ab'; reasons: string[] };

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** A usage object's input side, or null when it carries none of it. */
export function callUsage(usage: unknown): CallUsage | null {
  if (!isObject(usage)) return null;
  const input = num(usage.input_tokens);
  const creation = num(usage.cache_creation_input_tokens);
  const read = num(usage.cache_read_input_tokens);
  if (input === null && creation === null && read === null) return null;
  const buckets = isObject(usage.cache_creation) ? usage.cache_creation : {};
  return {
    input: input ?? 0,
    creation: creation ?? 0,
    read: read ?? 0,
    fiveMinute: num(buckets.ephemeral_5m_input_tokens),
    oneHour: num(buckets.ephemeral_1h_input_tokens),
  };
}

/** The share of a call's cached prefix it had to write. */
export function writeShare(usage: CallUsage): number | null {
  const cached = usage.creation + usage.read;
  return cached === 0 ? null : usage.creation / cached;
}

/** Every token the call's prompt held. */
export function promptTokens(usage: CallUsage): number {
  return usage.input + usage.creation + usage.read;
}

/** What the call wrote: 1 h when it wrote 1-hour entries, 5 min when it wrote any other, null when none. */
function writtenTtl(usage: CallUsage): number | null {
  if ((usage.oneHour ?? 0) > 0) return ONE_HOUR_MS;
  return usage.creation > 0 || (usage.fiveMinute ?? 0) > 0 ? FIVE_MINUTES_MS : null;
}

function time(line: JsonObject): number | null {
  if (typeof line.timestamp !== 'string') return null;
  const at = Date.parse(line.timestamp);
  return Number.isNaN(at) ? null : at;
}

/** A prompt the person typed: a user line whose content is text, not meta, a tool result or a summary. */
function startsTurn(line: JsonObject): boolean {
  if (line.type !== 'user' || line.isMeta === true || line.isSidechain === true) return false;
  if (line.isCompactSummary === true) return false;
  return isObject(line.message) && typeof line.message.content === 'string';
}

/** An assistant line a model wrote, with its message id. */
function callOf(line: JsonObject): { id: string; usage: CallUsage | null } | null {
  if (line.type !== 'assistant' || line.isSidechain === true || !isObject(line.message)) {
    return null;
  }
  if (line.message.model === SYNTHETIC_MODEL) return null;
  const id = typeof line.message.id === 'string' ? line.message.id : '';
  return { id, usage: callUsage(line.message.usage) };
}

/**
 * One session file's turns. A turn starts at a typed prompt; its first call is
 * the first assistant message after it, by message.id (Claude Code writes one
 * line per content block, each carrying the call's usage). For each resumed
 * turn: the first call's usage, the gap since the last call before it, and
 * whether that gap fell inside the TTL the latest call that wrote any entry
 * wrote them with (5 min when no call before it wrote any).
 */
export function turnStats(lines: readonly unknown[]): SessionStats {
  let turns = 0;
  const resumed: ResumedTurn[] = [];
  let current: ResumedTurn | null = null;
  let firstId: string | null = null;
  let lastCallAt: number | null = null;
  let ttlMs = FIVE_MINUTES_MS;
  for (const line of lines) {
    if (!isObject(line)) continue;
    if (startsTurn(line)) {
      turns += 1;
      firstId = null;
      current = null;
      if (turns < 2) continue;
      const at = time(line);
      const gapMs = at === null || lastCallAt === null ? null : at - lastCallAt;
      current = {
        turn: turns,
        gapMs,
        ttlMs,
        warm: gapMs === null ? null : gapMs < ttlMs,
        firstCall: null,
        share: null,
      };
      resumed.push(current);
      continue;
    }
    const call = callOf(line);
    if (call === null || turns === 0) continue;
    const at = time(line);
    if (at !== null) lastCallAt = at;
    if (call.usage !== null) {
      const written = writtenTtl(call.usage);
      if (written !== null) ttlMs = written;
    }
    if (current === null) continue;
    if (firstId === null) firstId = call.id;
    if (call.id === firstId && current.firstCall === null && call.usage !== null) {
      current.firstCall = call.usage;
      current.share = writeShare(call.usage);
    }
  }
  return { turns, resumed };
}

/** The value at quantile q (0 to 1), averaging the two middle values for the median; null for none. */
export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (q === 0.5) {
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  // Nearest rank.
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[rank - 1];
}

export const median = (values: readonly number[]) => quantile(values, 0.5);

/** The field, over every session read. */
export function summarize(sessions: readonly SessionStats[]): FieldSummary {
  const all = sessions.flatMap((session) => session.resumed);
  const metered = all.filter((turn) => turn.firstCall !== null);
  const timed = metered.filter((turn) => turn.warm !== null);
  const shares = (warm: boolean) =>
    timed
      .filter((turn) => turn.warm === warm && turn.share !== null)
      .map((turn) => turn.share as number);
  const warm = shares(true);
  const cold = shares(false);
  return {
    sessions: sessions.length,
    turns: sessions.reduce((sum, session) => sum + session.turns, 0),
    resumed: all.length,
    unmetered: all.length - metered.length,
    untimed: metered.length - timed.length,
    uncached: timed.filter((turn) => turn.share === null).length,
    warm: warm.length,
    cold: cold.length,
    warmShare: { median: median(warm), p90: quantile(warm, 0.9) },
    coldShare: { median: median(cold) },
  };
}

/**
 * Whether a session file is one of Cerebro's runs in one of the given vaults:
 * a line says `entrypoint: sdk-cli` and its cwd is one of `cwds` (each vault's
 * realpath). Matched by cwd, never by the project folder's slug.
 */
export function fromVault(lines: readonly unknown[], cwds: ReadonlySet<string>): boolean {
  return lines.some(
    (line) =>
      isObject(line) &&
      line.entrypoint === 'sdk-cli' &&
      typeof line.cwd === 'string' &&
      cwds.has(line.cwd),
  );
}

/** The CLI version a session file's lines name, or null. */
export function sessionVersion(lines: readonly unknown[]): string | null {
  for (const line of lines) {
    if (isObject(line) && typeof line.version === 'string') return line.version;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Gate 2: the A/B fixture (cache-ab.ts writes it through the spike's reducer).
// ---------------------------------------------------------------------------

export interface ArmTurn {
  turn: number;
  firstCall: CallUsage | null;
  result: CallUsage | null;
  costUsd: number | null;
  /** The turn's last call's whole prompt. */
  promptTokens: number | null;
}

export interface ArmSummary {
  turns: ArmTurn[];
  /** Summed over turns 2-6; null when any of them is unmetered. */
  laterCostUsd: number | null;
  finalPromptTokens: number | null;
}

export interface AbSummary {
  git: boolean;
  a: ArmSummary;
  b: ArmSummary;
  /** B's later cost over A's; null when either is unmetered or A's is zero. */
  costRatio: number | null;
  promptRatio: number | null;
}

interface FixtureLine {
  type?: string;
  message?: { id?: string; model?: string; usage?: unknown };
  usage?: unknown;
  total_cost_usd?: unknown;
}

export interface CacheAbFixture {
  cli_version: string;
  scenario: 'cache-ab';
  source: 'recorded';
  /** Whether the scratch vault was a git repo with a commit between turns. */
  git: boolean;
  arms: Record<'a' | 'b', { steps: { stream: FixtureLine[] }[] }>;
}

/** The turns the A/B's cost sums: 2 through 6. */
const LATER = { from: 1, to: 6 };

function armSummary(steps: readonly { stream: FixtureLine[] }[]): ArmSummary {
  const turns = steps.map((step, index): ArmTurn => {
    const calls = step.stream.filter(
      (line) => line.type === 'assistant' && line.message?.model !== SYNTHETIC_MODEL,
    );
    const first = calls.find((line) => callUsage(line.message?.usage) !== null);
    const last = [...calls].reverse().find((line) => callUsage(line.message?.usage) !== null);
    const result = step.stream.find((line) => line.type === 'result');
    const lastUsage = last ? callUsage(last.message?.usage) : null;
    return {
      turn: index + 1,
      firstCall: first ? callUsage(first.message?.usage) : null,
      result: result ? callUsage(result.usage) : null,
      costUsd: result ? num(result.total_cost_usd) : null,
      promptTokens: lastUsage ? promptTokens(lastUsage) : null,
    };
  });
  const later = turns.slice(LATER.from, LATER.to);
  const costs = later.map((turn) => turn.costUsd);
  const metered = later.length === LATER.to - LATER.from && costs.every((cost) => cost !== null);
  return {
    turns,
    laterCostUsd: metered ? (costs as number[]).reduce((sum, cost) => sum + cost, 0) : null,
    finalPromptTokens: turns.at(-1)?.promptTokens ?? null,
  };
}

const ratio = (b: number | null, a: number | null) =>
  a === null || b === null || a === 0 ? null : b / a;

export function abSummary(fixture: CacheAbFixture): AbSummary {
  const a = armSummary(fixture.arms.a.steps);
  const b = armSummary(fixture.arms.b.steps);
  return {
    git: fixture.git,
    a,
    b,
    costRatio: ratio(b.laterCostUsd, a.laterCostUsd),
    promptRatio: ratio(b.finalPromptTokens, a.finalPromptTokens),
  };
}

// ---------------------------------------------------------------------------
// The gates.
// ---------------------------------------------------------------------------

export const REASONS = {
  fewWarm: 'not enough warm resumed turns',
  survives: 'the prefix survives',
  noAb: 'the A/B has not run',
  abUnmetered: 'the A/B is missing a cost or a prompt size',
  noPay: 'the move does not pay',
  grows: 'the move grows the prompt too much',
  pays: 'the move pays',
} as const;

const fixed = (value: number) => value.toFixed(3);

/** Move or keep, with the threshold that decided it (Q28). */
export function gate(field: FieldSummary, ab?: AbSummary): Decision {
  if (field.warm < MIN_WARM_TURNS) {
    return {
      decision: 'keep',
      gate: 'field',
      reasons: [`${REASONS.fewWarm} (${field.warm} of ${MIN_WARM_TURNS})`],
    };
  }
  const share = field.warmShare.median;
  if (share === null || share <= WRITE_SHARE_LIMIT) {
    return {
      decision: 'keep',
      gate: 'field',
      reasons: [
        `${REASONS.survives} (median warm write share ${share === null ? 'not recorded' : fixed(share)}, at most ${WRITE_SHARE_LIMIT})`,
      ],
    };
  }
  if (ab === undefined) return { decision: 'keep', gate: 'ab', reasons: [REASONS.noAb] };
  if (ab.costRatio === null || ab.promptRatio === null) {
    return { decision: 'keep', gate: 'ab', reasons: [REASONS.abUnmetered] };
  }
  const reasons: string[] = [];
  if (ab.costRatio > COST_RATIO_LIMIT) {
    reasons.push(
      `${REASONS.noPay} (B costs ${fixed(ab.costRatio)} of A over turns 2-6, above ${COST_RATIO_LIMIT})`,
    );
  }
  if (ab.promptRatio > PROMPT_RATIO_LIMIT) {
    reasons.push(
      `${REASONS.grows} (B's final prompt is ${fixed(ab.promptRatio)} times A's, above ${PROMPT_RATIO_LIMIT})`,
    );
  }
  if (reasons.length > 0) return { decision: 'keep', gate: 'ab', reasons };
  return {
    decision: 'move',
    gate: 'ab',
    reasons: [
      `${REASONS.pays} (B costs ${fixed(ab.costRatio)} of A; its final prompt is ${fixed(ab.promptRatio)} times A's)`,
    ],
  };
}
