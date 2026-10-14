// @vitest-environment node
// The app's prompt modules import Vite's `?raw` text; the tools typecheck
// needs its declarations to follow them.
/// <reference types="vite/client" />
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '@/agent/systemPrompt';
import { renderSnapshot } from '@/agent/context';
import { grantedTools } from '@/engine/toolGrant';
import { armTurn, TURNS, withContext, type Composer } from './cache-ab';
import { report, sessionPaths } from './cache-report';
import {
  abSummary,
  callUsage,
  FIVE_MINUTES_MS,
  fromVault,
  gate,
  median,
  ONE_HOUR_MS,
  quantile,
  REASONS,
  summarize,
  turnStats,
  writeShare,
  type AbSummary,
  type CacheAbFixture,
  type FieldSummary,
} from './cache';

/**
 * M56.12's measurement, on synthetic sessions in Claude Code 2.1.250's shape:
 * a typed prompt is a user line with string content; each assistant content
 * block is its own line, carrying its call's usage under one message.id.
 */

const REPO = join(__dirname, '../..');
const RECORD = join(REPO, 'docs/superpowers/specs/2026-10-13-cerebro-m56-d4-transport-record.md');
const AB = join(REPO, 'src-tauri/fixtures/cli-stream/spike/cache-ab.json');
const VAULT = '/VAULT';
const T0 = Date.parse('2026-10-14T09:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();

interface Usage {
  creation: number;
  read: number;
  input?: number;
  fiveMinute?: number;
  oneHour?: number;
}

const usage = (u: Usage) => ({
  input_tokens: u.input ?? 3,
  output_tokens: 5,
  cache_creation_input_tokens: u.creation,
  cache_read_input_tokens: u.read,
  cache_creation: {
    ephemeral_5m_input_tokens: u.fiveMinute ?? 0,
    ephemeral_1h_input_tokens: u.oneHour ?? u.creation,
  },
});

const prompt = (ms: number, text = 'hello') => ({
  type: 'user',
  entrypoint: 'sdk-cli',
  cwd: VAULT,
  version: '2.1.250',
  timestamp: at(ms),
  message: { role: 'user', content: text },
});

let ids = 0;
/** One call: `blocks` assistant lines under one message id, each with the call's usage. */
function call(ms: number, u: Usage | null, blocks = 1) {
  ids += 1;
  const id = `msg_${String(ids).padStart(12, '0')}`;
  return Array.from({ length: blocks }, (_, block) => ({
    type: 'assistant',
    entrypoint: 'sdk-cli',
    cwd: VAULT,
    timestamp: at(ms + block),
    message: {
      id,
      model: 'claude-haiku-4-5-20251001',
      content: [{ type: 'text', text: 'ok' }],
      ...(u === null ? {} : { usage: usage(u) }),
    },
  }));
}

const toolResult = (ms: number) => ({
  type: 'user',
  timestamp: at(ms),
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x' }],
  },
});

const MIN = 60_000;

describe('turnStats', () => {
  it('starts a turn only at a typed prompt, and takes the first call after it', () => {
    const lines = [
      { type: 'queue-operation', operation: 'enqueue' },
      prompt(0),
      ...call(1_000, { creation: 30_000, read: 0 }, 2),
      toolResult(2_000),
      ...call(3_000, { creation: 200, read: 30_000 }),
      { ...prompt(4_000, 'meta'), isMeta: true },
      { ...prompt(4_000, 'summary'), isCompactSummary: true },
      { type: 'attachment', attachment: { type: 'skill_listing' } },
      prompt(10 * MIN),
      ...call(10 * MIN + 1_000, { creation: 500, read: 30_200 }, 3),
      ...call(10 * MIN + 2_000, { creation: 9_999, read: 1 }),
    ];
    const stats = turnStats(lines);
    expect(stats.turns).toBe(2);
    expect(stats.resumed).toHaveLength(1);
    const [turn] = stats.resumed;
    expect(turn.turn).toBe(2);
    expect(turn.firstCall).toMatchObject({ creation: 500, read: 30_200, oneHour: 500 });
    expect(turn.share).toBeCloseTo(500 / 30_700);
    // From the last call line of turn 1 to turn 2's prompt.
    expect(turn.gapMs).toBe(10 * MIN - 3_000);
  });

  it('skips a synthetic reply and a sidechain line when finding the first call', () => {
    const synthetic = call(5_000, { creation: 0, read: 0 }).map((line) => ({
      ...line,
      message: { ...line.message, model: '<synthetic>' },
    }));
    const side = call(5_500, { creation: 1, read: 1 }).map((line) => ({
      ...line,
      isSidechain: true,
    }));
    const lines = [
      prompt(0),
      ...call(1_000, { creation: 1_000, read: 0 }),
      prompt(2_000),
      ...synthetic,
      ...side,
      ...call(6_000, { creation: 10, read: 1_000 }),
    ];
    const [turn] = turnStats(lines).resumed;
    expect(turn.firstCall).toMatchObject({ creation: 10, read: 1_000 });
  });

  it('judges warmth by the TTL the last writing call used: 1 h and 5 min', () => {
    const oneHour = (gap: number) =>
      turnStats([
        prompt(0),
        ...call(0, { creation: 1_000, read: 0, oneHour: 1_000 }),
        prompt(gap),
        ...call(gap, { creation: 10, read: 1_000 }),
      ]).resumed[0];
    expect(oneHour(59 * MIN)).toMatchObject({ ttlMs: ONE_HOUR_MS, warm: true });
    expect(oneHour(61 * MIN)).toMatchObject({ ttlMs: ONE_HOUR_MS, warm: false });

    const fiveMinutes = (gap: number) =>
      turnStats([
        prompt(0),
        ...call(0, { creation: 1_000, read: 0, oneHour: 0, fiveMinute: 1_000 }),
        prompt(gap),
        ...call(gap, { creation: 10, read: 1_000 }),
      ]).resumed[0];
    expect(fiveMinutes(4 * MIN)).toMatchObject({ ttlMs: FIVE_MINUTES_MS, warm: true });
    expect(fiveMinutes(6 * MIN)).toMatchObject({ ttlMs: FIVE_MINUTES_MS, warm: false });
  });

  it('keeps the TTL of the latest call that wrote, past a call that only read', () => {
    const [, third] = turnStats([
      prompt(0),
      ...call(0, { creation: 1_000, read: 0, oneHour: 1_000 }),
      prompt(MIN),
      ...call(MIN, { creation: 0, read: 1_000, oneHour: 0 }),
      prompt(40 * MIN),
      ...call(40 * MIN, { creation: 0, read: 1_000, oneHour: 0 }),
    ]).resumed;
    expect(third).toMatchObject({ ttlMs: ONE_HOUR_MS, warm: true });
  });

  it('counts a turn with no usage as unmetered, never as a zero write', () => {
    const stats = turnStats([
      prompt(0),
      ...call(0, { creation: 1_000, read: 0 }),
      prompt(MIN),
      ...call(MIN, null),
    ]);
    expect(stats.resumed[0]).toMatchObject({ firstCall: null, share: null });
    const field = summarize([stats]);
    expect(field).toMatchObject({ resumed: 1, unmetered: 1, warm: 0, cold: 0 });
    expect(field.warmShare.median).toBeNull();
  });

  it('has no gap, so no warmth, without a timestamp or an earlier call', () => {
    const noTime = turnStats([
      prompt(0),
      ...call(0, { creation: 1_000, read: 0 }),
      { ...prompt(MIN), timestamp: undefined },
      ...call(MIN, { creation: 1, read: 1_000 }),
    ]).resumed[0];
    expect(noTime).toMatchObject({ gapMs: null, warm: null });
    const noCall = turnStats([prompt(0), prompt(MIN), ...call(MIN, { creation: 1, read: 1 })])
      .resumed[0];
    expect(noCall).toMatchObject({ gapMs: null, warm: null });
    expect(summarize([{ turns: 2, resumed: [noTime, noCall] }]).untimed).toBe(2);
  });
});

describe('usage', () => {
  it('reads the input side and leaves an unreported bucket null', () => {
    expect(callUsage({ input_tokens: 1, cache_read_input_tokens: 2 })).toEqual({
      input: 1,
      creation: 0,
      read: 2,
      fiveMinute: null,
      oneHour: null,
    });
    expect(callUsage({ output_tokens: 4 })).toBeNull();
    expect(callUsage(undefined)).toBeNull();
  });

  it('has no write share when nothing was cached', () => {
    expect(writeShare({ input: 9, creation: 0, read: 0, fiveMinute: 0, oneHour: 0 })).toBeNull();
    expect(writeShare({ input: 9, creation: 1, read: 3, fiveMinute: 0, oneHour: 1 })).toBe(0.25);
  });
});

describe('summarize', () => {
  it('takes medians and the p90 of warm turns, and the median of cold ones', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    const turn = (warm: boolean | null, share: number | null) => ({
      turn: 2,
      gapMs: warm === null ? null : 1,
      ttlMs: ONE_HOUR_MS,
      warm,
      firstCall: { input: 1, creation: 1, read: 1, fiveMinute: 0, oneHour: 1 },
      share,
    });
    const field = summarize([
      { turns: 4, resumed: [turn(true, 0.1), turn(true, 0.3), turn(false, 0.9)] },
      { turns: 3, resumed: [turn(true, 0.2), turn(true, null), turn(null, 0.5)] },
    ]);
    expect(field).toEqual({
      sessions: 2,
      turns: 7,
      resumed: 6,
      unmetered: 0,
      untimed: 1,
      uncached: 1,
      warm: 3,
      cold: 1,
      warmShare: { median: 0.2, p90: 0.3 },
      coldShare: { median: 0.9 },
    });
  });
});

const field = (warm: number, share: number | null): FieldSummary => ({
  sessions: 1,
  turns: warm + 1,
  resumed: warm,
  unmetered: 0,
  untimed: 0,
  uncached: 0,
  warm,
  cold: 0,
  warmShare: { median: share, p90: share },
  coldShare: { median: null },
});

const ab = (costRatio: number | null, promptRatio: number | null) =>
  ({ costRatio, promptRatio }) as AbSummary;

describe('gate', () => {
  it('keeps on too few warm turns, at 19, and goes on at 20', () => {
    const few = gate(field(19, 0.9));
    expect(few).toMatchObject({ decision: 'keep', gate: 'field' });
    expect(few.reasons[0]).toContain(REASONS.fewWarm);
    expect(gate(field(20, 0.9)).reasons).toEqual([REASONS.noAb]);
    expect(gate(field(0, null)).reasons[0]).toBe(`${REASONS.fewWarm} (0 of 20)`);
  });

  it('keeps when the median warm write share is 0.5 or less, or not recorded', () => {
    expect(gate(field(20, 0.5)).reasons[0]).toContain(REASONS.survives);
    expect(gate(field(20, null)).reasons[0]).toContain('not recorded');
    expect(gate(field(20, 0.51))).toMatchObject({ decision: 'keep', gate: 'ab' });
  });

  it('moves only when B costs at most 0.8 of A and its prompt is at most 1.5 times', () => {
    const passed = field(25, 0.9);
    expect(gate(passed, ab(0.8, 1.5)).decision).toBe('move');
    const costly = gate(passed, ab(0.81, 1));
    expect(costly).toMatchObject({ decision: 'keep', gate: 'ab' });
    expect(costly.reasons[0]).toContain(REASONS.noPay);
    const large = gate(passed, ab(0.5, 1.51));
    expect(large.decision).toBe('keep');
    expect(large.reasons[0]).toContain(REASONS.grows);
    expect(gate(passed, ab(0.9, 2)).reasons).toHaveLength(2);
    expect(gate(passed, ab(null, 1)).reasons).toEqual([REASONS.abUnmetered]);
  });
});

describe('the A/B fixture', () => {
  const step = (cost: number | null, first: Usage, last: Usage) => ({
    stream: [
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { id: 'msg_1', model: 'm', usage: usage(first) } },
      { type: 'assistant', message: { id: 'msg_2', model: 'm', usage: usage(last) } },
      { type: 'result', usage: usage(first), ...(cost === null ? {} : { total_cost_usd: cost }) },
    ],
  });
  const arm = (costs: (number | null)[], finalRead: number) =>
    costs.map((cost, index) =>
      step(
        cost,
        { creation: 100, read: 1_000 },
        {
          creation: 0,
          read: index === costs.length - 1 ? finalRead : 1_000,
          input: 0,
        },
      ),
    );
  const fixture = (a: ReturnType<typeof arm>, b: ReturnType<typeof arm>): CacheAbFixture => ({
    cli_version: '2.1.250',
    scenario: 'cache-ab',
    source: 'recorded',
    git: true,
    arms: { a: { steps: a }, b: { steps: b } },
  });

  it('sums turns 2-6 and compares the final prompts', () => {
    const summary = abSummary(
      fixture(
        arm([9, 0.1, 0.1, 0.1, 0.1, 0.1], 1_000),
        arm([9, 0.05, 0.05, 0.05, 0.05, 0.05], 1_400),
      ),
    );
    expect(summary.a.laterCostUsd).toBeCloseTo(0.5);
    expect(summary.costRatio).toBeCloseTo(0.5);
    expect(summary.promptRatio).toBeCloseTo(1.4);
    expect(summary.a.turns[0].firstCall).toMatchObject({ creation: 100, read: 1_000 });
  });

  it('leaves the cost unmetered when a turn has none', () => {
    const summary = abSummary(fixture(arm([1, 1, null, 1, 1, 1], 1), arm([1, 1, 1, 1, 1, 1], 1)));
    expect(summary.a.laterCostUsd).toBeNull();
    expect(summary.costRatio).toBeNull();
  });
});

describe('the field report', () => {
  const root = mkdtempSync(join(tmpdir(), 'cache-report-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('reads only top-level session files', () => {
    mkdirSync(join(root, 'projects/p/s1/subagents'), { recursive: true });
    writeFileSync(join(root, 'projects/p/s1.jsonl'), '');
    writeFileSync(join(root, 'projects/p/s1/subagents/agent.jsonl'), '');
    writeFileSync(join(root, 'projects/p/notes.txt'), '');
    expect(sessionPaths(join(root, 'projects'))).toEqual([join(root, 'projects/p/s1.jsonl')]);
    expect(sessionPaths(join(root, 'absent'))).toEqual([]);
  });

  it("keeps only Cerebro's sessions in the given vaults, and prints numbers only", () => {
    const session = [
      prompt(0),
      ...call(0, { creation: 1_000, read: 0 }),
      prompt(MIN),
      ...call(MIN, { creation: 10, read: 1_000 }),
    ];
    const elsewhere = session.map((line) => ({ ...line, cwd: '/ELSEWHERE' }));
    const interactive = session.map((line) => ({ ...line, entrypoint: 'claude-vscode' }));
    expect(fromVault(session, new Set([VAULT]))).toBe(true);
    expect(fromVault(elsewhere, new Set([VAULT]))).toBe(false);
    expect(fromVault(interactive, new Set([VAULT]))).toBe(false);
    const out = report([session, elsewhere, interactive], new Set([VAULT]));
    expect(out.versions).toEqual({ '2.1.250': 1 });
    expect(out.field).toMatchObject({ sessions: 1, resumed: 1, warm: 1 });
    expect(out.gate.decision).toBe('keep');
    const printed = JSON.stringify(out);
    expect(printed).not.toContain(VAULT);
    expect(printed).not.toContain('hello');
    expect(printed).not.toContain('msg_');
  });
});

describe('the A/B arms', () => {
  const composer: Composer = {
    buildSystemPrompt,
    renderSnapshot,
    grant: { tools: grantedTools(null), shell: false, attended: true },
  };
  const turns = (which: 'a' | 'b') =>
    Array.from({ length: TURNS }, (_, index) => armTurn(which, index + 1, composer));

  it("A's system prompt changes every turn and B's never does", () => {
    const a = turns('a');
    const b = turns('b');
    for (let index = 1; index < TURNS; index++) {
      expect(a[index].system).not.toBe(a[index - 1].system);
      expect(b[index].system).toBe(b[0].system);
    }
    expect(a[0].system).toContain('The user is currently looking at');
    expect(b[0].system).not.toContain('The user is currently looking at');
    expect(b[0].system).not.toContain('## Context snapshot');
  });

  it('B carries the same context in a leading block of the message', () => {
    const [a] = turns('a');
    const [b] = turns('b');
    expect(b.message.startsWith('<cerebro-context>\n')).toBe(true);
    expect(b.message.endsWith(`\n</cerebro-context>\n\n${a.message}`)).toBe(true);
    expect(b.message).toContain('## Context snapshot');
    expect(b.message).toContain('The user is currently looking at notes/beta-1.md.');
    expect(withContext('c', 'm')).toBe('<cerebro-context>\nc\n</cerebro-context>\n\nm');
  });
});

/** The record's M56.12 section: its field summary and the decision it states. */
function recorded(): { field: FieldSummary; decision: string; text: string } {
  const markdown = readFileSync(RECORD, 'utf8');
  const start = markdown.indexOf('## Resumed-turn cache (M56.12)');
  expect(start, 'the D4 record has the M56.12 section').toBeGreaterThan(-1);
  const rest = markdown.slice(start + 1);
  const text = rest.slice(0, rest.indexOf('\n## ') === -1 ? undefined : rest.indexOf('\n## '));
  const json = /```json\n([\s\S]*?)\n```/.exec(text)?.[1];
  const decision = /\*\*Decision:\*\* (keep|move)\b/.exec(text)?.[1];
  expect(json, 'the section holds the field summary').toBeDefined();
  expect(decision, 'the section states a decision').toBeDefined();
  return { field: JSON.parse(json as string) as FieldSummary, decision: decision as string, text };
}

describe('the D4 record', () => {
  it('states the decision its numbers give, naming the threshold that decided it', () => {
    const { field: summary, decision, text } = recorded();
    const measured = existsSync(AB)
      ? abSummary(JSON.parse(readFileSync(AB, 'utf8')) as CacheAbFixture)
      : undefined;
    const verdict = gate(summary, measured);
    expect(decision).toBe(verdict.decision);
    for (const reason of verdict.reasons) {
      expect(text.replace(/\s+/g, ' ')).toContain(reason);
    }
    // The A/B runs only after Gate 1 passes, and its fixture exists only then.
    if (verdict.gate === 'field') expect(existsSync(AB)).toBe(false);
  });
});
