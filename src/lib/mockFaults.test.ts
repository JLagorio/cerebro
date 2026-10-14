import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { armedFaults, failNext, faulted, resetFaults } from './mockFaults';

/**
 * The one fault seam (M64.1). A failure is one burst: every call in the task
 * that met it fails, and the next task reads again.
 */

afterEach(resetFaults);

const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const ok = () => Promise.resolve('read');

describe('failNext', () => {
  it('fails the next read of that command, then lets it through', async () => {
    failNext('fleet_runs');
    await expect(faulted('fleet_runs', ok)).rejects.toThrow(
      'state lab: fleet_runs was told to fail once',
    );
    await macrotask();
    await expect(faulted('fleet_runs', ok)).resolves.toBe('read');
  });

  it('fails every call in the same task, so a double effect sees one failure', async () => {
    failNext('fleet_runs');
    const first = faulted('fleet_runs', ok);
    const second = faulted('fleet_runs', ok);
    await expect(first).rejects.toThrow();
    await expect(second).rejects.toThrow();
    await macrotask();
    await expect(faulted('fleet_runs', ok)).resolves.toBe('read');
  });

  it('fails two separate reads when armed twice', async () => {
    failNext('fleet_runs');
    failNext('fleet_runs');
    expect(armedFaults()).toEqual({ fleet_runs: 2 });
    await expect(faulted('fleet_runs', ok)).rejects.toThrow();
    await macrotask();
    expect(armedFaults()).toEqual({ fleet_runs: 1 });
    await expect(faulted('fleet_runs', ok)).rejects.toThrow();
    await macrotask();
    expect(armedFaults()).toEqual({});
    await expect(faulted('fleet_runs', ok)).resolves.toBe('read');
  });

  it('is cleared by resetFaults, burst and all', async () => {
    failNext('fleet_runs');
    failNext('fleet_actor_summaries');
    void faulted('fleet_runs', ok).catch(() => undefined);
    resetFaults();
    expect(armedFaults()).toEqual({});
    await expect(faulted('fleet_runs', ok)).resolves.toBe('read');
    await expect(faulted('fleet_actor_summaries', ok)).resolves.toBe('read');
  });

  it('runs an unarmed command untouched, even while another is failing', async () => {
    const run = vi.fn(ok);
    failNext('fleet_runs');
    await expect(faulted('fleet_actor_summaries', run)).resolves.toBe('read');
    expect(run).toHaveBeenCalledTimes(1);
    expect(armedFaults()).toEqual({ fleet_runs: 1 });
  });

  it('never runs the read it fails', async () => {
    const run = vi.fn(ok);
    failNext('fleet_runs');
    await expect(faulted('fleet_runs', run)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it('is reachable from the window, for e2e', () => {
    (window as unknown as { __cerebroFailNext: (c: string) => void }).__cerebroFailNext('x');
    expect(armedFaults()).toEqual({ x: 1 });
  });
});

/**
 * A `faulted('x', …)` beside an invoke of some other command would arm one
 * name and fail another: the lab would say "fleet_runs failed" while the
 * section read something else. So every wrap sits in a function that also
 * invokes the command it names.
 */
const ADAPTERS = [
  'src/lib/ipc.ts',
  'src/lib/gitIpc.ts',
  'src/lib/rootsIpc.ts',
  'src/agent/agentIpc.ts',
];
const REPO = join(__dirname, '..', '..');

interface Wrap {
  file: string;
  command: string;
  invoked: string[];
}

function literalArg(call: ts.CallExpression): string | null {
  const first = call.arguments.at(0);
  return first !== undefined && ts.isStringLiteralLike(first) ? first.text : null;
}

function wrapsIn(file: string, source: string): Wrap[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: Wrap[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'faulted'
    ) {
      const command = literalArg(node) ?? '<not a literal>';
      let fn: ts.Node | undefined = node.parent;
      while (fn !== undefined && !ts.isFunctionLike(fn)) fn = fn.parent;
      const invoked: string[] = [];
      const collect = (inner: ts.Node): void => {
        if (
          ts.isCallExpression(inner) &&
          ts.isIdentifier(inner.expression) &&
          /^invoke/.test(inner.expression.text)
        ) {
          const name = literalArg(inner);
          if (name !== null) invoked.push(name);
        }
        ts.forEachChild(inner, collect);
      };
      if (fn !== undefined) collect(fn);
      out.push({ file, command, invoked });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe('the faulted wraps', () => {
  it('pairs every faulted(x) with an invoke of x in the same function', () => {
    const wraps = ADAPTERS.flatMap((file) => wrapsIn(file, readFileSync(join(REPO, file), 'utf8')));
    expect(wraps.map((w) => w.command)).toEqual(
      expect.arrayContaining(['fleet_runs', 'fleet_actor_summaries']),
    );
    const unpaired = wraps.filter((w) => !w.invoked.includes(w.command));
    expect(unpaired).toEqual([]);
  });

  it('catches a wrap that names another command', () => {
    const source = [
      'export function fleetRuns() {',
      "  return inTauri() ? invokeTauri('fleet_runs') : faulted('fleet_run', () => mock.x());",
      '}',
    ].join('\n');
    expect(wrapsIn('fake.ts', source)).toEqual([
      { file: 'fake.ts', command: 'fleet_run', invoked: ['fleet_runs'] },
    ]);
  });
});
