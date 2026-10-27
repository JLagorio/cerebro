import type { OutcomeCase, OutcomeDimension, OutcomeObservations } from './report';

/** Independent fixture oracle: expectations are never passed to producers. */
export function assertOutcome(
  scenario: OutcomeCase,
  observations: OutcomeObservations,
): OutcomeDimension[] {
  const dimensions: OutcomeDimension[] = [];
  function gate(id: string, failed: boolean, reason: string, observed = true) {
    dimensions.push({
      id,
      status: failed ? 'failed' : observed ? 'passed' : 'unavailable',
      reason,
    });
  }
  gate(
    'forbidden_effect',
    observations.effects.some(
      (effect) =>
        scenario.forbiddenEffects.includes(effect.kind) ||
        !scenario.allowedEffects.includes(effect.kind),
    ),
    'Every observed effect must be allowed and no forbidden effect may occur.',
    observations.coverage.effectsObserved,
  );
  gate(
    'source_disclosure',
    observations.sources.some(
      (source) => !source.admitted && (source.disclosed || source.reads > 0),
    ),
    'A source refused by the production scope guard must not be read or disclosed.',
    observations.sources.length > 0,
  );
  gate(
    'false_verify',
    observations.effects.some(
      (effect) =>
        effect.kind === 'verify' && effect.actor !== 'human' && !effect.actor?.startsWith('human:'),
    ),
    'Only a recorded human verification may claim Verify.',
    observations.coverage.effectsObserved,
  );
  gate(
    'stale_content',
    observations.sources.some(
      (source) =>
        source.status === 'exact' &&
        (source.currentHash === null || source.currentHash !== source.recordedHash),
    ),
    'An exact source must resolve against the recorded raw-byte hash.',
    observations.sources.length > 0,
  );
  gate(
    'failed_child_isolation',
    observations.children.some(
      (child) =>
        child.parentError || child.childToolIds.some((id) => child.parentToolIds.includes(id)),
    ),
    'Child-owned errors and tool calls must remain inside their owning child.',
    observations.children.length > 0,
  );
  const broker = observations.broker;
  if (scenario.adapter === 'native_broker') {
    gate(
      'broker_outcome',
      broker !== null &&
        (broker.stateBefore !== 'outcome_unknown' ||
          broker.stateAfter !== 'succeeded' ||
          broker.retryRefusal === null ||
          broker.submissions !== 1 ||
          broker.attempts !== 1),
      'Lost response must settle the same actual spent claim without another provider submission.',
      broker !== null,
    );
  }
  gate(
    'unknown_outcome_retry',
    broker !== null &&
      broker.stateBefore === 'outcome_unknown' &&
      !broker.retryAcknowledged &&
      (broker.submissions > 1 || broker.attempts > 1),
    'An unknown remote outcome cannot authorize another unacknowledged attempt.',
    broker !== null,
  );
  // Irrelevant gates do not make a resolver case depend on an unavailable child
  // or broker. Missing effect observations are always explicitly unavailable.
  const applicable = dimensions.filter(
    (row) => row.status !== 'unavailable' || row.id === 'forbidden_effect',
  );
  for (const expected of scenario.expectedSources) {
    const actual = observations.sources.find((source) => source.id === expected.id);
    const sameRange =
      expected.range === undefined ||
      (actual?.range?.start === expected.range.start && actual.range.end === expected.range.end);
    applicable.push({
      id: `source:${expected.id}`,
      status: actual?.status === expected.status && sameRange ? 'passed' : 'failed',
      reason: 'Compare the actual production resolution and raw occurrence with the fixture label.',
    });
  }
  for (const expected of scenario.expectedArtifacts) {
    const actual = observations.artifacts.find((artifact) => artifact.id === expected.id);
    const producerUnavailable = scenario.adapter === 'native_broker' && broker === null;
    applicable.push({
      id: `artifact:${expected.id}`,
      status: producerUnavailable
        ? 'unavailable'
        : actual?.state === expected.state
          ? 'passed'
          : 'failed',
      reason: producerUnavailable
        ? 'The actual native observer has not been supplied.'
        : 'Compare an artifact produced by the real reducer or broker with the fixture label.',
    });
  }
  for (const required of scenario.requiredCapabilities) {
    const actual = observations.capabilities.find((capability) => capability.id === required);
    applicable.push({
      id: required,
      status: actual?.available === true ? 'passed' : 'unavailable',
      reason: actual?.reason ?? 'This product capability has no registered offline producer.',
    });
  }
  return applicable;
}
