/**
 * The RFC3339 calendar gate (M27.11b). Rust validates stamps with chrono;
 * until this fix the TS side used a shape regex alone, so the mock applied
 * history the real reducer refuses — a `freshness.transitioned` dated
 * February 30th existed on one side only. No conformance vector can carry
 * the attack (the Rust generator builds typed bodies and cannot emit an
 * impossible stamp), so the parity claim is pinned here instead.
 */

import { describe, expect, it } from 'vitest';

import { validateCommon } from './schema';

function body(stamp: string | null) {
  return {
    schema: 1,
    batch_id: null,
    idempotency_key: null,
    actor: { id: 'human:owner' },
    occurred_at: stamp,
    valid_from: null,
    valid_to: null,
  };
}

describe('the RFC3339 gate refuses what chrono refuses', () => {
  it.each([
    '2026-02-30T00:00:00Z',
    '2026-02-29T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-00-10T00:00:00Z',
    '2026-04-31T00:00:00Z',
    '2026-08-12T25:00:00Z',
    '2026-08-12T12:61:00Z',
    '2026-08-12T12:00:61Z',
    '2026-08-12T12:00:00+99:00',
    '2026-08-12T12:00:00+05:75',
  ])('refuses %s', (stamp) => {
    expect(() => validateCommon(body(stamp))).toThrow(/is not RFC3339/);
  });

  it.each([
    '2026-02-28T00:00:00Z',
    '2024-02-29T00:00:00Z',
    '2000-02-29T00:00:00Z',
    '2026-08-12T23:59:60Z',
    '2026-08-12T12:00:00.123456789Z',
    '2026-08-12T12:00:00+23:59',
    '2026-08-12t12:00:00z',
  ])('accepts %s, exactly as chrono does', (stamp) => {
    expect(() => validateCommon(body(stamp))).not.toThrow();
  });

  it('a century year is not a leap year unless divisible by 400', () => {
    expect(() => validateCommon(body('1900-02-29T00:00:00Z'))).toThrow(/is not RFC3339/);
  });
});
