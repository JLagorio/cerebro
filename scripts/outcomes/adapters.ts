import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sourceCases from '../../shared/knowledge/source-location-cases.json';
import { applyEvent, endLiveTurn } from '../../src/agent/transcript';
import type { AgentStreamEvent, ChatMessage, ToolCall } from '../../src/agent/types';
import { splitFrontmatter } from '../../src/engine/frontmatter';
import {
  resolveSourceWith,
  sourceLocatorForWindow,
  type SourceLocator,
} from '../../src/engine/sourceLocation';
import { reduce, type VectorFrame } from '../../src/lib/epistemic/reduce';
import { boundedJson, object, safeRelative, string } from './parse';
import { readNativeCapture } from './native-capture';
import type { OutcomeAdapters, OutcomeCase, OutcomeObservations, OutcomeReport } from './report';

export const REPO = fileURLToPath(new URL('../../', import.meta.url));
const IDENTITY_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'rust-toolchain.toml',
  'shared/policy/policy.v3.json',
  'shared/policy/tools.v1.json',
  'shared/policy/tool-approval.v1.json',
  'shared/policy/actions.v1.json',
  'shared/knowledge/source-location.v1.json',
  'shared/knowledge/source-location-cases.json',
  'src/engine/sourceLocation.ts',
  'src/agent/transcript.ts',
  'src/lib/epistemic/reduce.ts',
  'src-tauri/src/actions/service.rs',
  'conformance/outcomes/native.rs',
  'conformance/contradiction.json',
  'scripts/outcomes/native-inputs.ts',
  'scripts/outcomes/native-capture.ts',
  'scripts/outcomes/run.ts',
  'scripts/outcomes/assert.ts',
  'scripts/outcomes/adapters.ts',
  'scripts/outcomes/parse.ts',
  'scripts/outcomes/report.ts',
  'scripts/outcomes/negative-controls.ts',
];
export const hash = (bytes: string | Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');
export function sourceDigests(): Record<string, string> {
  return Object.fromEntries(
    IDENTITY_FILES.map((path) => {
      const file = join(REPO, path);
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024)
        throw new Error('Identity source is unavailable or exceeds its cap.');
      return [path, hash(readFileSync(file))];
    }),
  );
}
export function identity(clock: () => string): OutcomeReport['identity'] {
  return {
    evaluatedAt: clock(),
    node: process.version,
    cli: { observed: null, reason: 'Offline replay does not invoke or inspect an installed CLI.' },
    model: { observed: null, reason: 'No model was invoked in this offline replay.' },
    sourceDigests: sourceDigests(),
    build: {
      kind: 'source_snapshot',
      binaryHash: null,
      reason: 'Actual source-byte fingerprints; no installed application binary was inspected.',
    },
  };
}
export function emptyObservations(): OutcomeObservations {
  return {
    capabilities: [],
    sources: [],
    effects: [],
    artifacts: [],
    children: [],
    broker: null,
    files: [],
    refusals: [],
    coverage: { effectsObserved: false, limitations: [] },
    nativeCapture: null,
    usage: {
      costUsd: null,
      durationMs: null,
      reason: 'Offline model cost and end-to-end duration were not recorded.',
    },
  };
}
function snapshot(root: string): Map<string, string> {
  const rows = new Map<string, string>();
  const pending = [''];
  let visited = 0;
  while (pending.length) {
    const relative = pending.pop()!;
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      if (++visited > 256) throw new Error('Disposable state entry cap exceeded.');
      const path = join(relative, entry.name);
      const full = join(root, path);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error('Disposable state may not contain symlinks.');
      if (stat.isDirectory()) pending.push(path);
      else if (stat.isFile() && stat.size <= 262144) rows.set(path, hash(readFileSync(full)));
      else throw new Error('Disposable state file exceeds its cap.');
    }
  }
  return rows;
}
function observedChanges(
  root: string,
  before: Map<string, string>,
  observations: OutcomeObservations,
) {
  const after = snapshot(root);
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const beforeHash = before.get(path) ?? null;
    const afterHash = after.get(path) ?? null;
    if (beforeHash !== afterHash) {
      observations.files.push({ path, beforeHash, afterHash });
      observations.effects.push({ kind: 'write', target: path, actor: null });
    }
  }
  observations.coverage.effectsObserved = true;
}
interface SourceVector {
  name: string;
  original: string;
  current: string | null;
  locator: SourceLocator;
  currentFields: { key: string; text: string }[];
  allowed: boolean;
  vaultId: string;
  readUnavailable?: boolean;
  otherFiles?: Record<string, string>;
}
function sourceVectors(inputs: Record<string, unknown>): SourceVector[] {
  const names = inputs.vectors as string[];
  const shared = sourceCases.cases as SourceVector[];
  const selected = names.map((name) => {
    const found = shared.find((row) => row.name === name);
    if (!found) throw new Error('Unknown shared source vector.');
    return found;
  });
  for (const value of (inputs.variants ?? []) as Record<string, unknown>[]) {
    const original = value.original as string;
    const locator = sourceLocatorForWindow(
      value.vaultId as string,
      value.path as string,
      hash(original),
      splitFrontmatter(original).body,
      value.range as { start: number; end: number },
    );
    if (!locator) throw new Error('Variant cannot produce a valid source locator.');
    selected.push({
      name: value.id as string,
      original,
      current: value.current as string | null,
      locator,
      currentFields: [],
      allowed: value.readable as boolean,
      vaultId: value.vaultId as string,
      otherFiles: value.otherFiles as Record<string, string> | undefined,
    });
  }
  return selected;
}
function sourceAdapter(
  inputs: Record<string, unknown>,
  root: string,
  observations: OutcomeObservations,
) {
  for (const [index, vector] of sourceVectors(inputs).entries()) {
    const local = join(root, String(index));
    mkdirSync(local);
    const path = safeRelative(vector.locator.path);
    const file = join(local, path);
    if (vector.current !== null) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, vector.current, { flag: 'wx', mode: 0o600 });
    }
    for (const [other, body] of Object.entries(vector.otherFiles ?? {})) {
      const target = join(local, safeRelative(other));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body, { flag: 'wx', mode: 0o600 });
    }
    const before = snapshot(local);
    let reads = 0;
    let currentHash: string | null = null;
    const result = resolveSourceWith(
      { vaultId: vector.vaultId, admits: () => vector.allowed },
      vector.locator,
      () => {
        reads++;
        if (vector.readUnavailable || vector.current === null) return null;
        const raw = readFileSync(file, 'utf8');
        currentHash = hash(raw);
        return {
          sourceHash: currentHash,
          body: splitFrontmatter(raw).body,
          fields: vector.currentFields,
          carrier: path.endsWith('.md') ? 'markdown' : 'unsupported',
        };
      },
    );
    observedChanges(local, before, observations);
    observations.sources.push({
      id: vector.name,
      vaultId: vector.locator.vaultId,
      path: vector.locator.path,
      status: result.status,
      recordedHash: vector.locator.sourceHash,
      currentHash,
      disclosed: 'locator' in result,
      admitted: vector.allowed && vector.vaultId === vector.locator.vaultId,
      reads,
      ...('locator' in result && result.locator.bodyUtf8Range !== undefined
        ? { range: result.locator.bodyUtf8Range }
        : {}),
    });
  }
  observations.capabilities.push({
    id: 'source_resolution',
    available: true,
    reason: 'Production source resolver over disposable synthetic source bytes.',
  });
  observations.coverage.limitations.push(
    'Passage resolution only; no model answer quality or native editor reveal is claimed.',
  );
}
function ledgerAdapter(inputs: Record<string, unknown>, observations: OutcomeObservations) {
  if (inputs.vector !== 'contradiction') throw new Error('Unsupported ledger vector.');
  const vector = object(boundedJson(join(REPO, 'conformance/contradiction.json'), 4 * 1024 * 1024));
  const state = reduce(vector.events as VectorFrame[], string(vector.store_id));
  observations.artifacts = [...state.contradictionEdges.values()].map((edge) => ({
    id: `contradiction:${edge.edgeId}`,
    state: edge.closed === null ? 'open' : 'closed',
  }));
  observations.refusals = state.anomalies.map((row) => ({ eventId: row.event_id, code: row.code }));
  observations.capabilities.push({
    id: 'counterevidence_replay',
    available: true,
    reason:
      'The production reducer retained actual contradiction edges from Rust conformance events.',
  });
  observations.coverage.limitations.push(
    'Reducer state is observed; natural-language answer quality is unavailable.',
  );
}
function transcriptAdapter(inputs: Record<string, unknown>, observations: OutcomeObservations) {
  let message: ChatMessage = {
    id: 'outcome-parent',
    role: 'assistant',
    text: '',
    tools: [],
    streaming: true,
  };
  for (const event of inputs.events as AgentStreamEvent[])
    message = applyEvent(message, event, 'live', 'outcome-session');
  message = endLiveTurn(message);
  const visit = (tools: ToolCall[]) => {
    for (const call of tools)
      if (call.subagent) {
        observations.children.push({
          id: call.id,
          status: call.subagent.status,
          parentError: message.error !== undefined,
          parentToolIds: message.tools.map((tool) => tool.id),
          childToolIds: call.subagent.tools.map((tool) => tool.id),
        });
        observations.artifacts.push({ id: `child:${call.id}`, state: call.subagent.status });
        visit(call.subagent.tools);
      }
  };
  visit(message.tools);
  observations.capabilities.push({
    id: 'child_transcript_isolation',
    available: true,
    reason: 'Production transcript reducer consumed deterministic folded child events.',
  });
  observations.coverage.limitations.push(
    'Transcript isolation only; no native child authority or live CLI task is claimed.',
  );
}
function nativeAdapter(path: string | undefined, observations: OutcomeObservations) {
  if (!path) {
    observations.capabilities.push({
      id: 'native_broker',
      available: false,
      reason: 'The explicitly captured offline native broker observation was not supplied.',
    });
    return;
  }
  const capture = readNativeCapture(path, REPO);
  observations.nativeCapture = {
    observedAt: capture.observedAt,
    clock: capture.clock,
    nativeInputs: capture.nativeInputs,
  };
  observations.broker = capture.broker;
  observations.effects = capture.effects;
  observations.artifacts = capture.artifacts;
  observations.capabilities.push({
    id: 'native_broker',
    available: true,
    reason:
      'Actual M96 SQLite broker observation with complete declared producer input identity checked.',
  });
  observations.coverage.effectsObserved = true;
  observations.coverage.limitations.push(...capture.limits);
}
/** Inputs only: no expected sources, effects or artifact labels reach an adapter. */
export function observe(
  scenario: Pick<OutcomeCase, 'adapter' | 'inputs'>,
  adapters: OutcomeAdapters,
): OutcomeObservations {
  const root = realpathSync(resolve(adapters.root));
  if (!lstatSync(root).isDirectory() || readdirSync(root).length !== 0)
    throw new Error('Adapter requires empty disposable state.');
  const observations = emptyObservations();
  if (scenario.adapter === 'source_location') sourceAdapter(scenario.inputs, root, observations);
  else if (scenario.adapter === 'native_broker') nativeAdapter(adapters.nativeReport, observations);
  else if (scenario.adapter === 'unavailable') {
    observations.capabilities.push({
      id: string(scenario.inputs.capability),
      available: false,
      reason: string(scenario.inputs.reason),
    });
    observations.coverage.limitations.push(
      'This outcome has no actual registered producer; no absence of effects is asserted.',
    );
  } else {
    const before = snapshot(root);
    if (scenario.adapter === 'ledger_conformance') ledgerAdapter(scenario.inputs, observations);
    else if (scenario.adapter === 'transcript') transcriptAdapter(scenario.inputs, observations);
    else throw new Error('Unknown adapter.');
    observedChanges(root, before, observations);
  }
  return observations;
}
