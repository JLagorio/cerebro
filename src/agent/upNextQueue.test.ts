import { describe, expect, it } from 'vitest';
import {
  claimHead,
  edit,
  enqueue,
  isTyped,
  remove,
  STEER_BY_RESTART,
  toFront,
  UP_NEXT_CAP,
  type UpNextEntry,
} from './upNextQueue';

const entry = (id: string, over: Partial<UpNextEntry> = {}): UpNextEntry => ({
  id,
  text: `message ${id}`,
  skill: null,
  narrowing: {},
  turn: { systemPrompt: () => `context ${id}`, place: null, conversationId: 'c-1' },
  vault: '/vault',
  queuedAt: 0,
  ...over,
});

const ids = (queue: UpNextEntry[]) => queue.map((e) => e.id);

describe('Up next, the queue (M57.5)', () => {
  it(`holds ${UP_NEXT_CAP} and answers full after`, () => {
    let queue: UpNextEntry[] = [];
    for (let i = 0; i < UP_NEXT_CAP; i += 1) {
      const next = enqueue(queue, entry(`e${i}`));
      if (next === 'full') throw new Error('full too soon');
      queue = next;
    }
    expect(UP_NEXT_CAP).toBe(10);
    expect(enqueue(queue, entry('one-more'))).toBe('full');
    expect(queue).toHaveLength(10);
  });

  it('edits a typed entry in place, keeping its id and position', () => {
    const queue = [entry('a'), entry('b'), entry('c')];
    const expansion = Promise.resolve('EXPANDED');
    const edited = edit(queue, 'b', '  /weekly-review now ', {
      skill: { path: 'skills/weekly-review.md' },
      expansion,
      narrowing: { allowedTools: ['get_note'] },
    });
    expect(ids(edited)).toEqual(['a', 'b', 'c']);
    expect(edited[1]).toMatchObject({
      id: 'b',
      text: '/weekly-review now',
      skill: { path: 'skills/weekly-review.md' },
      narrowing: { allowedTools: ['get_note'] },
    });
    expect(edited[1].expansion).toBe(expansion);
    expect(edited[1].turn).toBe(queue[1].turn);
    // Plain text drops the old skill's expansion.
    const plain = edit(edited, 'b', 'just words', { skill: null, narrowing: {} });
    expect(plain[1].expansion).toBeUndefined();
    expect(plain[1].skill).toBeNull();
  });

  it('refuses to edit a handoff entry, blank text, or an id not queued', () => {
    const queue = [entry('a'), entry('h', { text: 'Ask to revise · A', prompt: 'Revise …' })];
    const none = { skill: null, narrowing: {} };
    expect(edit(queue, 'h', 'changed', none)).toBe(queue);
    expect(edit(queue, 'a', '   ', none)).toBe(queue);
    expect(edit(queue, 'zz', 'changed', none)).toBe(queue);
  });

  it('refuses to edit a review-notes entry, which carries its note ids (M58.5)', () => {
    const notes = entry('n', {
      text: 'I reviewed your changes…',
      notes: { ids: ['rn-1', 'rn-2'] },
    });
    const queue = [notes];
    expect(isTyped(notes)).toBe(false);
    expect(isTyped(entry('a'))).toBe(true);
    expect(edit(queue, 'n', 'changed', { skill: null, narrowing: {} })).toBe(queue);
    expect(queue[0].notes?.ids).toEqual(['rn-1', 'rn-2']);
  });

  it('removes an entry, and leaves the queue for an id not queued', () => {
    const queue = [entry('a'), entry('b')];
    expect(ids(remove(queue, 'a'))).toEqual(['b']);
    expect(remove(queue, 'zz')).toBe(queue);
  });

  it('moves an entry to the front, and leaves the head alone', () => {
    const queue = [entry('a'), entry('b'), entry('c')];
    expect(ids(toFront(queue, 'c'))).toEqual(['c', 'a', 'b']);
    expect(ids(toFront(queue, 'b'))).toEqual(['b', 'a', 'c']);
    expect(toFront(queue, 'a')).toBe(queue);
    expect(toFront(queue, 'zz')).toBe(queue);
  });

  it('claims the head, or nothing from an empty queue', () => {
    const queue = [entry('a'), entry('b')];
    const claimed = claimHead(queue);
    expect(claimed?.entry.id).toBe('a');
    expect(ids(claimed?.rest ?? [])).toEqual(['b']);
    expect(claimHead([])).toBeNull();
  });
});

/** The kill-resume scenario's steps, as the spike fixture holds them. */
interface Step {
  argv: string[];
  exit: { code: number | null; stopped: boolean };
  stream: {
    type?: string;
    subtype?: string;
    is_error?: boolean;
    message?: { content?: unknown };
  }[];
}
interface Scenario {
  source?: string;
  steps: Step[];
}

const recorded = import.meta.glob<Scenario>(
  '../../src-tauri/fixtures/cli-stream/spike/kill-resume.json',
  { eager: true, import: 'default' },
);
const killResume: Scenario | undefined = Object.values(recorded)[0];

type Block = { type?: string; id?: string; tool_use_id?: string };
const blocks = (step: Step): Block[] =>
  step.stream.flatMap((line) =>
    Array.isArray(line.message?.content) ? (line.message.content as Block[]) : [],
  );
const flag = (argv: string[], name: string) => {
  const at = argv.indexOf(name);
  return at === -1 ? null : argv[at + 1];
};

/**
 * F17 for Steer: after a stop mid-tool, the resume of the same session exits
 * 0 with a successful result, and every tool_use it makes is answered. Only
 * then may Steer restart a run instead of interrupting it.
 */
function steerResumes(scenario: Scenario): boolean {
  const [stopped, resumed] = scenario.steps;
  if (stopped === undefined || resumed === undefined || !stopped.exit.stopped) return false;
  if (!blocks(stopped).some((b) => b.type === 'tool_use')) return false;
  if (flag(resumed.argv, '--resume') !== flag(stopped.argv, '--session-id')) return false;
  const result = resumed.stream.find((line) => line.type === 'result');
  if (resumed.exit.code !== 0 || result?.subtype !== 'success' || result.is_error === true) {
    return false;
  }
  const answered = new Set(
    blocks(resumed).flatMap((b) => (b.type === 'tool_result' ? [b.tool_use_id] : [])),
  );
  return blocks(resumed)
    .filter((b) => b.type === 'tool_use')
    .every((b) => answered.has(b.id));
}

const owed = killResume === undefined || killResume.source !== 'recorded';

describe('Steer and the transport (M57.5, D4 (a))', () => {
  it(
    owed
      ? 'Steer follows the kill-resume recording (F17): live run owed, so the D4 default holds'
      : 'Steer follows the kill-resume recording (F17)',
    () => {
      if (owed || killResume === undefined) {
        // The fixture is derived from the 2.1.250 bundle until the owner's
        // login records it; D4 (a) says Steer restarts.
        expect(killResume?.source ?? 'absent').not.toBe('recorded');
        expect(STEER_BY_RESTART).toBe(true);
        return;
      }
      expect(STEER_BY_RESTART).toBe(steerResumes(killResume));
    },
  );
});
