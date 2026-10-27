import { fileURLToPath } from 'node:url';
import {
  NATIVE_INPUT_LIMITS,
  nativeInputIdentity,
  type NativeInputIdentity,
} from './native-inputs';
import { array, boundedJson, keys, object, string } from './parse';
import type { OutcomeObservations } from './report';

export interface NativeCapture {
  version: 1;
  scenario: 'lost-response';
  producer: string;
  observedAt: string;
  clock: string;
  nativeInputs: NativeInputIdentity;
  broker: NonNullable<OutcomeObservations['broker']>;
  effects: OutcomeObservations['effects'];
  artifacts: OutcomeObservations['artifacts'];
  limits: string[];
}

/** The offline adapter and disposable-repository tests share this actual reader.
 * The CLI has no repository-root override. Input identities are observations,
 * never authority tokens; they cover the declared repository inputs only.
 */
export function readNativeCapture(
  path: string,
  repositoryRoot = fileURLToPath(new URL('../../', import.meta.url)),
): NativeCapture {
  const raw = object(boundedJson(path, 65536));
  keys(raw, [
    'version',
    'scenario',
    'producer',
    'observedAt',
    'clock',
    'nativeInputs',
    'broker',
    'effects',
    'artifacts',
    'limits',
  ]);
  if (
    raw.version !== 1 ||
    raw.scenario !== 'lost-response' ||
    raw.producer !== 'actions::service::test_support::Harness' ||
    raw.clock !== 'wall_clock_not_injected' ||
    !Number.isFinite(Date.parse(string(raw.observedAt)))
  )
    throw new Error('Invalid native observer identity.');
  const inputs = object(raw.nativeInputs);
  keys(inputs, ['version', 'aggregateDigest', 'fileCount', 'totalBytes']);
  if (
    inputs.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(string(inputs.aggregateDigest)) ||
    !Number.isSafeInteger(inputs.fileCount) ||
    (inputs.fileCount as number) < 1 ||
    (inputs.fileCount as number) > NATIVE_INPUT_LIMITS.files ||
    !Number.isSafeInteger(inputs.totalBytes) ||
    (inputs.totalBytes as number) < 0 ||
    (inputs.totalBytes as number) > NATIVE_INPUT_LIMITS.totalBytes
  )
    throw new Error('Invalid bounded native input identity.');
  const broker = object(raw.broker);
  keys(broker, [
    'stateBefore',
    'stateAfter',
    'submissions',
    'attempts',
    'retryAcknowledged',
    'retryRefusal',
    'producer',
  ]);
  for (const key of ['submissions', 'attempts'])
    if (!Number.isSafeInteger(broker[key]) || (broker[key] as number) < 0)
      throw new Error('Invalid broker counter.');
  if (typeof broker.retryAcknowledged !== 'boolean' || broker.producer !== raw.producer)
    throw new Error('Invalid broker observation.');
  const states = [
    'prepared',
    'awaiting_approval',
    'ready',
    'dispatched',
    'succeeded',
    'failed',
    'outcome_unknown',
    'cancelled',
  ];
  if (!states.includes(string(broker.stateBefore)) || !states.includes(string(broker.stateAfter)))
    throw new Error('Invalid broker state.');
  if (broker.retryRefusal !== null) string(broker.retryRefusal);
  const effects = array(raw.effects).map((value) => {
    const row = object(value);
    keys(row, ['kind', 'target', 'actor']);
    return {
      kind: string(row.kind),
      target: string(row.target),
      actor: row.actor === null ? null : string(row.actor),
    };
  });
  const artifacts = array(raw.artifacts).map((value) => {
    const row = object(value);
    keys(row, ['id', 'state']);
    return { id: string(row.id), state: string(row.state) };
  });
  const limits = array(raw.limits).map(string);
  // Discovery is from fixed roots, with exact generated path-set parity. The
  // report supplies no file paths to read and cannot narrow its own inventory.
  const current = nativeInputIdentity(repositoryRoot);
  if (
    inputs.aggregateDigest !== current.aggregateDigest ||
    inputs.fileCount !== current.fileCount ||
    inputs.totalBytes !== current.totalBytes
  )
    throw new Error('Native capture input identity is stale.');
  return {
    version: 1,
    scenario: 'lost-response',
    producer: string(raw.producer),
    observedAt: string(raw.observedAt),
    clock: string(raw.clock),
    nativeInputs: current,
    broker: broker as unknown as NonNullable<OutcomeObservations['broker']>,
    effects,
    artifacts,
    limits,
  };
}
