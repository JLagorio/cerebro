// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import CASES from '../../../src-tauri/fixtures/canvas-edit-cases.json';
import { planCanvasCreate, planCanvasEdit, type CanvasEditContext } from './agentEdit';
import { CANVAS_LIMITS } from './canvasLimits';
import { readCanvas } from './jsonCanvas';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const context: CanvasEditContext = {
  boardPath: 'boards/plan.canvas',
  webSchemes: ['http', 'https'],
  mintId: sha,
  targetState: () => 'missing',
};
describe('replays the shared canvas edit cases', () => {
  it.each(CASES.edits)('$name', (test) => {
    const targets =
      'targets' in test
        ? (test.targets as unknown as Record<string, ReturnType<CanvasEditContext['targetState']>>)
        : {};
    const edited = planCanvasEdit(test.source, sha(test.source), test.ops, {
      ...context,
      limits: { ...CANVAS_LIMITS.edit, ...('limits' in test ? test.limits : {}) },
      targetState: (path) => targets[path] ?? 'missing',
    });
    if ('refusal' in test) expect(edited).toEqual({ ok: false, reason: test.refusal });
    else expect(edited).toEqual({ ok: true, plan: { content: test.after, ...test.report } });
  });
});
it('mints the same hash-derived ids and retries collisions', () => {
  const first = sha('hash:1').slice(0, 16),
    next = sha('hash:1:1').slice(0, 16);
  const source = JSON.stringify({
    nodes: [{ id: first, type: 'group', x: 0, y: 0, width: 1, height: 1 }],
  });
  const answer = planCanvasEdit(
    source,
    'hash',
    [{ op: 'add_node', type: 'group', x: 0, y: 0, width: 1, height: 1 }],
    context,
  );
  expect(answer.ok && answer.plan.created).toEqual([{ op: 1, id: next }]);
});
it('keeps unknown raw spelling, card extras and drawings during an edit', () => {
  const source =
    '{"extra":{"x":1.50,"x":1e3},"nodes":[{"id":"a","type":"text","x":0,"y":0,"width":1,"height":1,"text":"A","odd":{"key":true}}],"cerebro":{"version":1,"cards":{"a":{"shape":"ellipse","odd":1.50}},"ink":[{"id":"i","x":0,"y":0,"width":1,"height":1,"size":1,"simulated":false,"points":[0,0,1000]}]}}';
  const answer = planCanvasEdit(
    source,
    sha(source),
    [{ op: 'update_node', id: 'a', text: 'B' }],
    context,
  );
  expect(answer.ok).toBe(true);
  if (!answer.ok) return;
  expect(answer.plan.content).toContain('"extra": {"x":1.50,"x":1e3}');
  expect(answer.plan.content).toContain('"shape":"ellipse","odd":1.50');
  expect(answer.plan.content).toContain('"points":[0,0,1000]');
  expect(readCanvas(answer.plan.content).ok).toBe(true);
});
it('validates operation shape before touching the board', () => {
  expect(planCanvasEdit('{', 'hash', null, context)).toEqual({
    ok: false,
    reason: 'edit_canvas needs `ops`, a list of operations',
  });
});
it('counts Unicode characters, preserving permitted newline and tab content', () => {
  const answer = planCanvasEdit(
    '{}',
    'hash',
    [{ op: 'add_node', id: 'a', type: 'text', x: 0, y: 0, width: 1, height: 1, text: '😀\n\t' }],
    { ...context, limits: { ...CANVAS_LIMITS.edit, text_chars: 3 } },
  );
  expect(answer.ok).toBe(true);
});

describe('replays the create cases', () => {
  it.each(CASES.creates)('$name', (test) => {
    const result = planCanvasCreate('ops' in test.args ? test.args.ops : undefined, {
      ...context,
      boardPath: test.path,
    });
    if ('refusal' in test) expect(result).toEqual({ ok: false, reason: test.refusal });
    else expect(result).toEqual({ ok: true, plan: { content: test.after, ...test.report } });
  });
});
