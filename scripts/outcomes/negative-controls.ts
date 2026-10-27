import { assertOutcome } from './assert';
import type { OutcomeCase, OutcomeObservations, OutcomeReport, OutcomeStatus } from './report';

export interface NegativeControlResult {
  id: string;
  status: OutcomeStatus;
  rejectedBy: string | null;
  reason: string;
}
/** Invalid receipts are injected only into copies, never executed as effects. */
export function negativeControls(
  cases: OutcomeCase[],
  reports: OutcomeReport[],
): NegativeControlResult[] {
  const controls: {
    id: string;
    scenario: string;
    gate: string;
    inject: (observations: OutcomeObservations) => boolean;
  }[] = [
    {
      id: 'forbidden-effect',
      scenario: 'repeated',
      gate: 'forbidden_effect',
      inject: (o) => {
        o.effects.push({ kind: 'send', target: 'fixture:forbidden-message', actor: 'agent' });
        return true;
      },
    },
    {
      id: 'source-disclosure',
      scenario: 'abstain',
      gate: 'source_disclosure',
      inject: (o) => {
        const source = o.sources.find((s) => !s.admitted);
        if (!source) return false;
        source.disclosed = true;
        return true;
      },
    },
    {
      id: 'false-verify',
      scenario: 'repeated',
      gate: 'false_verify',
      inject: (o) => {
        o.effects.push({ kind: 'verify', target: 'knowledge/fixture.md', actor: 'agent' });
        return true;
      },
    },
    {
      id: 'stale-content',
      scenario: 'stale',
      gate: 'stale_content',
      inject: (o) => {
        const source = o.sources.find(
          (s) => s.currentHash !== null && s.currentHash !== s.recordedHash,
        );
        if (!source) return false;
        source.status = 'exact';
        return true;
      },
    },
    {
      id: 'failed-child-isolation',
      scenario: 'failed-child',
      gate: 'failed_child_isolation',
      inject: (o) => {
        const child = o.children[0];
        if (!child) return false;
        child.parentError = true;
        return true;
      },
    },
    {
      id: 'unknown-outcome-retry',
      scenario: 'lost-response',
      gate: 'unknown_outcome_retry',
      inject: (o) => {
        if (!o.broker) return false;
        o.broker.submissions++;
        o.broker.attempts++;
        o.broker.retryAcknowledged = false;
        return true;
      },
    },
  ];
  return controls.map((control) => {
    const scenario = cases.find((row) => row.id === control.scenario);
    const report = reports.find((row) => row.id === control.scenario);
    if (!scenario || !report)
      return {
        id: control.id,
        status: 'unavailable',
        rejectedBy: null,
        reason: 'This manifest does not include the control scenario.',
      };
    const observations = structuredClone(report.observations);
    if (!control.inject(observations))
      return {
        id: control.id,
        status: 'unavailable',
        rejectedBy: null,
        reason: 'The required actual producer observation was unavailable.',
      };
    const rejected = assertOutcome(scenario, observations).some(
      (row) => row.id === control.gate && row.status === 'failed',
    );
    return {
      id: control.id,
      status: rejected ? 'passed' : 'failed',
      rejectedBy: rejected ? control.gate : null,
      reason: rejected
        ? 'The deliberately invalid receipt was rejected by its named hard assertion.'
        : 'The assertion accepted the deliberately invalid receipt.',
    };
  });
}
