import { describe, expect, it } from 'vitest';
import {
  approvalKey,
  presetSpec,
  CONNECTOR_PRESETS,
  type ConnectorSpec,
  type ConnectorStatusRow,
} from '@/engine/connectors';
import {
  approvalLine,
  CONNECTOR_HINTS,
  connectorFocus,
  connectorRow,
  focusedConnector,
  signInWithout,
  type ConnectorStatusRead,
} from './connectorRow';

/**
 * One connector's status as Settings says it and the rail's Connectors card
 * says it (M54.11, M92.9): one derivation, first rule wins.
 */

const http = (name: string, over: Partial<ConnectorSpec> = {}): ConnectorSpec => ({
  name,
  transport: 'http',
  url: `https://${name.toLowerCase()}.example.test/mcp`,
  command: '',
  args: [],
  enabled: true,
  extra: {},
  ...over,
});

const GMAIL = http('Gmail');
/** This machine approved Gmail's exact spec. */
const APPROVED = [approvalKey(GMAIL) as string];

const seen = (over: Partial<ConnectorStatusRow>): ConnectorStatusRow => ({
  connector: 'Gmail',
  cli_name: 'Gmail',
  refused: null,
  state: null,
  signal: null,
  seen_at: null,
  run_id: null,
  ...over,
});

const ready = (...rows: ConnectorStatusRow[]): ConnectorStatusRead => ({ kind: 'ready', rows });

describe('connectorRow', () => {
  it('reads the switch first, whatever a run saw', () => {
    const row = connectorRow(
      { ...GMAIL, enabled: false },
      APPROVED,
      ready(seen({ state: 'working' })),
    );
    expect(row.status).toEqual({ key: 'off', words: 'off' });
    expect(row.quiet).toBe(true);
    expect(row.signIn).toBe(false);
  });

  it("says a refused name in Rust's words, before the approval", () => {
    const reason = "its name holds __, which the CLI reads as the end of a server's name";
    const row = connectorRow(GMAIL, [], ready(seen({ refused: reason })));
    expect(row.status).toEqual({ key: 'refused', words: `can’t be granted: ${reason}` });
    expect(row.quiet).toBe(false);
  });

  it('says why an entry is not approved here, by what its spec holds', () => {
    expect(connectorRow(GMAIL, [], ready()).status).toEqual({
      key: 'unapproved',
      words: 'not approved on this machine',
    });
    const headers = http('jira', { extra: { headers: { 'X-Retries': 3 } } });
    expect(connectorRow(headers, [], ready()).status.words).toBe('malformed headers');
    expect(connectorRow(headers, [], ready()).approval).toBeNull();
    const oauth = http('toy', { extra: { oauth: { scopes: ['read'] } } });
    expect(connectorRow(oauth, [], ready()).status.words).toBe('oauth Claude Code would refuse');
    const late = http('late', { extra: { timeout: 999 } });
    expect(connectorRow(late, [], ready()).status.words).toBe('timeout Claude Code would refuse');
    const stdio: ConnectorSpec = { ...http('files'), transport: 'stdio', url: '', command: 'npx' };
    expect(connectorRow(stdio, [], ready()).status.words).toBe('runs a local command');
    const badEnv: ConnectorSpec = { ...stdio, extra: { env: { KEY: 1 } } };
    expect(connectorRow(badEnv, [], ready()).status.words).toBe('malformed env');
  });

  it('says no state while the status read is out or failed, never not observed yet', () => {
    expect(connectorRow(GMAIL, APPROVED, { kind: 'loading' }).status).toEqual({
      key: 'loading',
      words: null,
    });
    expect(
      connectorRow(GMAIL, APPROVED, { kind: 'unavailable', reason: 'no runtime database' }).status,
    ).toEqual({ key: 'unavailable', words: null });
  });

  it('says what the newest run saw, or that none has', () => {
    expect(connectorRow(GMAIL, APPROVED, ready()).status).toEqual({
      key: 'not_observed',
      words: 'not observed yet',
    });
    for (const [state, words, quiet] of [
      ['working', 'working', true],
      ['needs_sign_in', 'needs sign-in', false],
      ['failed', 'failed', false],
      ['not_approved', 'not approved', false],
    ] as const) {
      const row = connectorRow(GMAIL, APPROVED, ready(seen({ state })));
      expect(row.status).toEqual({ key: state, words });
      expect(row.quiet).toBe(quiet);
    }
  });

  it('carries when an observed state was seen, and a hint where there is something to do', () => {
    const at = '2026-07-28T11:00:00.000Z';
    const failed = connectorRow(GMAIL, APPROVED, ready(seen({ state: 'failed', seen_at: at })));
    expect(failed.observedAt).toBe(at);
    expect(failed.hint).toBe(CONNECTOR_HINTS.failed);
    const off = connectorRow({ ...GMAIL, enabled: false }, APPROVED, ready(seen({ seen_at: at })));
    expect(off.observedAt).toBeNull();
    expect(off.hint).toBeUndefined();
  });

  it('shows its sign-in when it needs one, and for a preset no run has used', () => {
    const needs = connectorRow(GMAIL, APPROVED, ready(seen({ state: 'needs_sign_in' })));
    expect(needs.signIn).toBe(true);
    expect(needs.command).toBe(
      'claude mcp add --transport http Gmail https://gmail.example.test/mcp',
    );
    expect(connectorRow(GMAIL, APPROVED, ready()).signIn).toBe(false);
    const linear = presetSpec(CONNECTOR_PRESETS[0]);
    const unused = connectorRow(linear, [approvalKey(linear) as string], ready());
    expect(unused.signIn).toBe(true);
    expect(unused.command).toContain('claude mcp add-json linear');
    const dotted = http('toy.v2');
    const blocked = connectorRow(
      dotted,
      [approvalKey(dotted) as string],
      ready(seen({ connector: 'toy.v2', state: 'needs_sign_in' })),
    );
    expect(blocked.signIn).toBe(true);
    expect(blocked.command).toBeNull();
    expect(signInWithout(dotted)).toBe(
      'Claude Code adds a connector only under a name of letters, digits, - and _, so rename toy.v2 here, then sign in.',
    );
  });

  it('keeps what Approve approves out of the row', () => {
    const secret = http('jira', { extra: { headers: { Authorization: 'Bearer sekrit' } } });
    const row = connectorRow(secret, [], ready());
    expect(JSON.stringify({ ...row, spec: undefined })).not.toContain('sekrit');
    expect(approvalLine(secret)).toBe(
      'https://jira.example.test/mcp · Authorization: Bearer sekrit',
    );
  });
});

describe('the rail’s Settings focus', () => {
  it('names a connector, and only a connector', () => {
    expect(focusedConnector(connectorFocus('Gmail'))).toBe('Gmail');
    expect(focusedConnector(connectorFocus('a:b'))).toBe('a:b');
    expect(focusedConnector('claude-code')).toBeNull();
    expect(focusedConnector(null)).toBeNull();
  });
});

describe('M96.4a connectorRow ownership facts', () => {
  const legacy = http('m96-http', {
    url: 'https://m96-route.example.test/mcp',
    extra: { headers: { Authorization: 'm96-header-sentinel' }, oauth: { scopes: 'read write' } },
  });
  const oldApproval = approvalKey(legacy) as string;
  const marked = (marker: Record<string, unknown>, enabled = true): ConnectorSpec => ({
    ...legacy,
    enabled,
    extra: { ...legacy.extra, ...marker },
  });
  const reads: ConnectorStatusRead[] = [
    { kind: 'loading' },
    { kind: 'unavailable', reason: 'no runtime database' },
    ready(),
    ...(['working', 'needs_sign_in'] as const).map((state) =>
      ready(
        seen({
          connector: legacy.name,
          cli_name: legacy.name,
          state,
          seen_at: '2026-10-13T10:00:00.000Z',
          run_id: 'historical-run',
        }),
      ),
    ),
  ];

  it('m96_owner_managed_row_is_non_callable_even_when_off_or_status_is_unavailable', () => {
    expect(connectorRow(legacy, [oldApproval], reads[3]).status.key).toBe('working');
    for (const enabled of [true, false]) {
      for (const status of reads) {
        const row = connectorRow(
          marked({ executionOwner: 'cerebro' }, enabled),
          [oldApproval],
          status,
        );
        expect(row.status.words).toMatch(/managed.*unavailable/i);
        expect(row.approval).toBeNull();
        expect(row.signIn).toBe(false);
        expect(row.command).toBeNull();
        expect(row.observedAt).toBeNull();
        expect(row.quiet).toBe(false);
        expect(row.status.words).not.toMatch(/working|needs sign-in|not observed yet/i);
      }
    }
  });

  it('m96_owner_invalid_and_orphan_rows_need_file_correction_independently_of_status', () => {
    for (const marker of [
      ...([null, 7, true, '', 'Cerebro', 'CLI', 'unknown', [], {}] as unknown[]).map(
        (executionOwner) => ({ executionOwner }),
      ),
      { secretRef: null },
      { executionOwner: 'cli', secretRef: { opaque: 'm96-reference-sentinel' } },
    ]) {
      for (const status of reads) {
        const row = connectorRow(marked(marker), [oldApproval], status);
        expect(row.status.words).toMatch(/ownership/i);
        expect(row.status.words).toMatch(/file|correct/i);
        expect(row.status.words).not.toMatch(/managed.*unavailable/i);
        expect(row.approval).toBeNull();
        expect(row.signIn).toBe(false);
        expect(row.command).toBeNull();
        expect(row.observedAt).toBeNull();
        expect(row.quiet).toBe(false);
      }
    }
  });

  it('m96_owner_approval_display_and_signin_fallback_do_not_reveal_raw_routes', () => {
    for (const marker of [
      { executionOwner: 'cerebro', secretRef: { opaque: 'm96-reference-sentinel' } },
      { executionOwner: 'unknown' },
      { secretRef: null },
    ]) {
      for (const spec of [
        marked(marker),
        {
          ...marked(marker),
          transport: 'stdio' as const,
          command: 'm96-unexecuted-command',
          args: ['m96-arg-sentinel'],
          extra: { ...marker, env: { TOKEN: 'm96-env-sentinel' } },
        },
      ]) {
        const display = approvalLine(spec);
        for (const payload of [
          'https://m96-route.example.test/mcp',
          'm96-header-sentinel',
          'm96-unexecuted-command',
          'm96-arg-sentinel',
          'm96-env-sentinel',
          'm96-reference-sentinel',
        ])
          expect(display).not.toContain(payload);
        expect(signInWithout(spec)).not.toMatch(/run claude|\/mcp|then sign in/i);
      }
    }
    expect(approvalLine(legacy)).toContain('m96-header-sentinel');
    expect(connectorRow(legacy, [oldApproval], reads[4]).signIn).toBe(true);
    const explicit = marked({ executionOwner: 'cli' });
    expect(connectorRow(explicit, [oldApproval], reads[4])).toEqual({
      ...connectorRow(legacy, [oldApproval], reads[4]),
      spec: explicit,
    });
  });
});
