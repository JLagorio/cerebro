/**
 * Structural rules pinned directly, beside the conformance replay.
 *
 * The RFC3339 calendar gate (M27.11b). Rust validates stamps with chrono;
 * until this fix the TS side used a shape regex alone, so the mock applied
 * history the real reducer refuses — a `freshness.transitioned` dated
 * February 30th existed on one side only. No conformance vector can carry
 * the attack (the Rust generator builds typed bodies and cannot emit an
 * impossible stamp), so the parity claim is pinned here instead.
 *
 * The projection-path claim (M53.29). `projection-claims.json` replays the
 * refused and accepted claims, nesting included; the full shape list, DEL
 * and the C1 controls (which the vector generator would write raw), and the
 * rule that only the first `.md` alias is judged, are pinned here against
 * `validate_projection_path` and `validate_claimable_path`.
 */

import { describe, expect, it } from 'vitest';

import type { Json } from './ids';
import {
  decodeBody,
  RefusedError,
  validateBody,
  validateClaimablePath,
  validateCommon,
  validateProjectionPath,
} from './schema';

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

describe('a projection path is relative markdown, spelled one way, naming a file', () => {
  // What a person files under a dot-folder, or as a dotfile with a stem,
  // the migration and the move adoption record as written.
  it.each(['concepts/acme.md', 'acme.md', '.archive/x.md', '.hidden.md'])('accepts %j', (path) => {
    expect(() => validateProjectionPath(path)).not.toThrow();
  });

  it.each([
    '',
    '/abs.md',
    'no-extension',
    'a//b.md',
    '../escape.md',
    'a/../b.md',
    'back\\slash.md',
    './x.md',
    'a/./b.md',
    '.md',
    'a/.md',
  ])('refuses %j', (path) => {
    expect(() => validateProjectionPath(path)).toThrow(RefusedError);
  });
});

const leaf = (bytes: number) => `concepts/${'a'.repeat(bytes - 3)}.md`;
const folder = (bytes: number) => `${'d'.repeat(bytes)}/acme.md`;
const WIDE = '概';

describe('a claimable path is one the projection writer can create', () => {
  it.each([
    'concepts/acme.md',
    '.archive/x.md',
    leaf(243),
    folder(255),
    // U+00A0 is the first code point past the C1 controls.
    'concepts/a b.md',
    // 80 CJK characters and the extension: 243 bytes.
    `concepts/${WIDE.repeat(80)}.md`,
  ])('accepts %j', (path) => {
    expect(() => validateClaimablePath(path)).not.toThrow();
  });

  it.each([
    'concepts/a\u0000b.md',
    'concepts/a\u001fb.md',
    'concepts/a\nb.md',
    'concepts/a\u007fb.md',
    'concepts/a\u0080b.md',
    'concepts/a\u009fb.md',
    leaf(244),
    // 82 CJK characters and the extension: 85 code units, 249 bytes.
    `concepts/${WIDE.repeat(82)}.md`,
    folder(256),
    '../escape.md',
  ])('refuses %j', (path) => {
    expect(() => validateClaimablePath(path)).toThrow(RefusedError);
  });

  it('holds only a claim to the writer: a filed path keeps the shape rule alone', () => {
    expect(() => validateProjectionPath('concepts/a\u007fb.md')).not.toThrow();
    expect(() => validateProjectionPath(leaf(255))).not.toThrow();
  });
});

const STORE = 'feedfacefeedfacefeedfacefeedface';

function validateCreated(aliases: string[]): void {
  const created: Json = {
    schema: 1,
    batch_id: null,
    idempotency_key: null,
    actor: { id: 'agent:run-1' },
    occurred_at: null,
    valid_from: null,
    valid_to: null,
    belief_id: 'e'.repeat(32),
    subject: { resolution: 'resolved', entity_id: 'c'.repeat(32), aliases },
    content: '# Acme\n\nActive vendor.\n',
    fields: { status: 'active' },
    basis: { state: 'unsupported', reason: 'conformance fixture without observations' },
  };
  const decoded = decodeBody('belief.created', created);
  if (decoded === null) throw new Error('belief.created decoded as plumbing');
  validateBody(decoded, STORE);
}

describe('a created Belief claims only a writable projection path', () => {
  it('accepts a writable claim, and aliases that claim nothing', () => {
    expect(() => validateCreated(['concepts/acme.md'])).not.toThrow();
    expect(() => validateCreated(['Acme Corp', '../not/a/claim'])).not.toThrow();
  });

  it.each([
    '../escape.md',
    '.md',
    'concepts/./acme.md',
    '/concepts/acme.md',
    'a//b.md',
    'concepts/a\u0000b.md',
    leaf(244),
  ])('refuses the claim %j', (claim) => {
    expect(() => validateCreated(['Acme Corp', claim])).toThrow(/projection path/);
  });

  it('judges only the first .md alias', () => {
    expect(() => validateCreated(['concepts/acme.md', '../escape.md'])).not.toThrow();
    expect(() => validateCreated(['../escape.md', 'concepts/acme.md'])).toThrow(RefusedError);
  });
});
