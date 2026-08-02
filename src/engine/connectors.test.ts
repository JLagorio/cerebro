import { describe, expect, it } from 'vitest';
import {
  parseConnectors,
  scrubStdioApprovals,
  serializeConnectors,
  stdioApprovalKey,
  stdioFingerprint,
  type ConnectorSpec,
} from './connectors';

describe('connectors config', () => {
  it('round-trips both transports and preserves unmodeled keys', () => {
    const raw = JSON.stringify({
      servers: {
        jira: {
          transport: 'http',
          url: 'https://jira/mcp',
          headers: { Authorization: 'Bearer t' },
          enabled: true,
        },
        linear: {
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@linear/mcp'],
          env: { KEY: 'v' },
          enabled: false,
        },
      },
    });
    const specs = parseConnectors(raw);
    expect(specs.map((s) => s.name)).toEqual(['jira', 'linear']);
    expect(specs[0].extra).toEqual({ headers: { Authorization: 'Bearer t' } });
    expect(specs[1].args).toEqual(['-y', '@linear/mcp']);

    const reparsed = JSON.parse(serializeConnectors(specs));
    expect(reparsed.servers.jira.headers.Authorization).toBe('Bearer t');
    expect(reparsed.servers.linear.env.KEY).toBe('v');
    expect(reparsed.servers.linear.enabled).toBe(false);
  });

  it('shows an empty list for absent or broken config', () => {
    expect(parseConnectors('')).toEqual([]);
    expect(parseConnectors('{not json')).toEqual([]);
    expect(parseConnectors('{"servers": 3}')).toEqual([]);
  });

  it('treats anything but explicit enabled: true as off', () => {
    const specs = parseConnectors('{"servers": {"a": {"transport": "http", "url": "u"}}}');
    expect(specs[0].enabled).toBe(false);
  });
});

describe('stdio approval fingerprints (PR #5 security review)', () => {
  const spec = (over: Partial<ConnectorSpec> = {}): ConnectorSpec => ({
    name: 'linear',
    transport: 'stdio',
    url: '',
    command: 'npx',
    args: ['-y', '@linear/mcp'],
    enabled: true,
    extra: { env: { KEY: 'v' } },
    ...over,
  });

  it('pins the exact literal the Rust merge computes', () => {
    // connectors.rs#the_fingerprint_format_is_pinned_to_the_frontends pins
    // the SAME strings — if either side drifts, its own suite fails before
    // the two can disagree at runtime.
    expect(stdioFingerprint(spec())).toBe('["linear","npx",["-y","@linear/mcp"],[["KEY","v"]]]');
    expect(stdioFingerprint(spec({ name: 'a', command: 'b', args: [], extra: {} }))).toBe(
      '["a","b",[],[]]',
    );
  });

  it('is env-order independent, and null for http or an env it cannot cover', () => {
    expect(stdioFingerprint(spec({ extra: { env: { B: '2', A: '1' } } }))).toBe(
      stdioFingerprint(spec({ extra: { env: { A: '1', B: '2' } } })),
    );
    expect(stdioFingerprint(spec({ transport: 'http' }))).toBeNull();
    // A non-string env value would run with content the fingerprint never
    // described, so the spec is not approvable at all.
    expect(stdioFingerprint(spec({ extra: { env: { KEY: 7 } } }))).toBeNull();
    expect(stdioFingerprint(spec({ extra: { env: 'PATH=x' } }))).toBeNull();
  });

  it('the approval key pins the exact hex the Rust merge computes', () => {
    // connectors.rs#the_approval_key_is_pinned_to_the_frontends pins the
    // SAME literals. The ledger stores this digest, never the fingerprint:
    // env values are credential material, and localStorage must not become
    // a second plaintext home for them (PR #5 security review).
    expect(stdioApprovalKey(spec())).toBe(
      '4292a8986901db1abb3288b95ff7b6ab150dbda22d2fe4699e88f143e67a5ad6',
    );
    expect(stdioApprovalKey(spec({ name: 'a', command: 'b', args: [], extra: {} }))).toBe(
      'c7c7371a155e18e5c9f39283b6a98a2b6f3d946306f494a04ece6c6d3c4fbccb',
    );
    // Null propagates: what cannot be fingerprinted cannot be approved.
    expect(stdioApprovalKey(spec({ transport: 'http' }))).toBeNull();
    expect(stdioApprovalKey(spec({ extra: { env: { KEY: 7 } } }))).toBeNull();
  });

  it('scrubbing a pre-digest ledger hashes raw fingerprints in place', () => {
    const raw = stdioFingerprint(spec())!;
    const key = stdioApprovalKey(spec())!;
    const scrubbed = scrubStdioApprovals({
      '/vault': [raw, key],
      '/other': [key],
    });
    // The raw entry became its key — the approval survives, the env-bearing
    // plaintext does not — and already-hashed entries pass through.
    expect(scrubbed.changed).toBe(true);
    expect(scrubbed.map).toEqual({ '/vault': [key, key], '/other': [key] });
    // An all-digest ledger reports unchanged, so nothing re-persists on
    // every launch.
    expect(scrubStdioApprovals(scrubbed.map).changed).toBe(false);
  });
});
