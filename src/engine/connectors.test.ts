import { describe, expect, it } from 'vitest';
import CONNECTOR_APPROVALS from '../../src-tauri/fixtures/connector-approvals.json';
import {
  approvalKey,
  CONNECTOR_PRESETS,
  httpOAuth,
  presetHolder,
  presetSpec,
  removalNote,
  httpApprovalKey,
  httpFingerprint,
  parseConnectors,
  readConnectorList,
  scrubStdioApprovals,
  serializeConnectors,
  signInBlocker,
  signInCommand,
  stateLabel,
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
    expect(parseConnectors('null')).toEqual([]);
  });

  it('tells bytes that do not parse apart from a list of no servers', () => {
    expect(readConnectorList('')).toEqual({ kind: 'specs', specs: [] });
    expect(readConnectorList('{not json')).toEqual({ kind: 'unreadable' });
    expect(readConnectorList('{"servers": 3}')).toEqual({ kind: 'specs', specs: [] });
    expect(readConnectorList('null')).toEqual({ kind: 'specs', specs: [] });
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

describe('http approval fingerprints (M54.9)', () => {
  const spec = (over: Partial<ConnectorSpec> = {}): ConnectorSpec => ({
    name: 'jira',
    transport: 'http',
    url: 'https://jira/mcp',
    command: '',
    args: [],
    enabled: true,
    extra: { headers: { Authorization: 'Bearer t' } },
    ...over,
  });

  it('pins the exact literal and hex the Rust merge computes', () => {
    // connectors.rs#the_http_approval_key_is_pinned_to_the_frontends pins
    // the SAME strings, so the side that approves and the side that merges
    // cannot drift apart unnoticed.
    expect(httpFingerprint(spec())).toBe(
      '["jira","http","https://jira/mcp",[["Authorization","Bearer t"]]]',
    );
    expect(httpFingerprint(spec({ name: 'a', url: 'b', extra: {} }))).toBe('["a","http","b",[]]');
    expect(httpApprovalKey(spec())).toBe(
      '5728f62e09feffea4e276f396417756c6e2f8173ebb54c1bc1acd0a10f794439',
    );
    expect(httpApprovalKey(spec({ name: 'a', url: 'b', extra: {} }))).toBe(
      '97340277369b0af8f6ba278027e18b738e8aaabbc4fcdad3ad68c0fa7c2f422f',
    );
  });

  it('does not care about header order, and changes with the url or any header', () => {
    const both = { Authorization: 'Bearer t', 'X-Team': 'core' };
    expect(
      httpApprovalKey(
        spec({ extra: { headers: { 'X-Team': 'core', Authorization: 'Bearer t' } } }),
      ),
    ).toBe(httpApprovalKey(spec({ extra: { headers: both } })));
    const approved = httpApprovalKey(spec({ extra: { headers: both } }));
    for (const edited of [
      spec({ url: 'https://elsewhere/mcp', extra: { headers: both } }),
      spec({ extra: { headers: { ...both, Authorization: 'Bearer other' } } }),
      spec({ extra: { headers: { Authorization: 'Bearer t' } } }),
    ]) {
      expect(httpApprovalKey(edited)).not.toBe(approved);
    }
  });

  it('is null for a header it cannot cover, and for a stdio spec', () => {
    expect(httpFingerprint(spec({ extra: { headers: { 'X-Retries': 3 } } }))).toBeNull();
    expect(httpFingerprint(spec({ extra: { headers: ['Authorization: Bearer t'] } }))).toBeNull();
    expect(httpApprovalKey(spec({ extra: { headers: null } }))).toBeNull();
    expect(httpFingerprint(spec({ transport: 'stdio' }))).toBeNull();
  });

  it('approvalKey picks the transport’s own key', () => {
    expect(approvalKey(spec())).toBe(httpApprovalKey(spec()));
    const stdio = spec({ transport: 'stdio', command: 'npx', extra: {} });
    expect(approvalKey(stdio)).toBe(stdioApprovalKey(stdio));
    expect(approvalKey(stdio)).not.toBe(httpApprovalKey(spec({ extra: {} })));
  });
});

describe('connector status (M54.11)', () => {
  const http = (name: string, url: string, headers?: Record<string, unknown>): ConnectorSpec => ({
    name,
    transport: 'http',
    url,
    command: '',
    args: [],
    enabled: true,
    extra: headers === undefined ? {} : { headers },
  });

  it('signInCommand is the claude mcp add line for the exact entry', () => {
    expect(signInCommand(http('Gmail', 'https://gmail.example.test/mcp'))).toBe(
      'claude mcp add --transport http Gmail https://gmail.example.test/mcp',
    );
  });

  it('signInCommand quotes a word only when a shell would read it otherwise', () => {
    // Each recorded against `claude mcp add` on 2.1.250, which stored the
    // URL and header values exactly as written here.
    expect(signInCommand(http('jira', 'https://jira.test/mcp?a=1&b=2'))).toBe(
      "claude mcp add --transport http jira 'https://jira.test/mcp?a=1&b=2'",
    );
    expect(signInCommand(http('jira', 'https://jira.test/my mcp'))).toBe(
      "claude mcp add --transport http jira 'https://jira.test/my mcp'",
    );
    expect(
      signInCommand(http('jira', 'https://jira.test/mcp', { 'X-Team': 'core', 'X-Note': "it's" })),
    ).toBe(
      "claude mcp add --transport http jira https://jira.test/mcp --header 'X-Note: it'\\''s' --header 'X-Team: core'",
    );
    expect(signInCommand(http('jira', '=https://jira.test/mcp'))).toBe(
      "claude mcp add --transport http jira '=https://jira.test/mcp'",
    );
  });

  it('signInCommand sorts the headers by name, the order the run’s config holds them', () => {
    // Claude Code files a sign-in under a hash of the server's type, URL and
    // headers in order (read from 2.1.250), and connectors.rs merges the
    // headers sorted, so a command in file order would sign in a twin.
    expect(
      signInCommand(
        http('jira', 'https://jira.test/mcp', { 'X-Team': 'core', Authorization: 'Bearer t' }),
      ),
    ).toBe(
      "claude mcp add --transport http jira https://jira.test/mcp --header 'Authorization: Bearer t' --header 'X-Team: core'",
    );
  });

  it('signInCommand puts a name that starts with - after a --', () => {
    expect(signInCommand(http('-dash', 'https://y.test/mcp', { A: 'b' }))).toBe(
      "claude mcp add --transport http --header 'A: b' -- -dash https://y.test/mcp",
    );
  });

  it('signInCommand is null where the command cannot be built exactly', () => {
    // `claude mcp add` refuses names outside letters, digits, - and _.
    for (const name of ['my toy', 'toy.v2', 'H\u00e9llo', 'a"b', '']) {
      expect(signInCommand(http(name, 'https://x.test/mcp'))).toBeNull();
    }
    expect(signInCommand(http('jira', 'https://jira.test/mcp', { 'X-Retries': 3 }))).toBeNull();
    const stdio: ConnectorSpec = {
      name: 'linear',
      transport: 'stdio',
      url: '',
      command: 'npx',
      args: ['-y', '@linear/mcp'],
      enabled: true,
      extra: {},
    };
    expect(signInCommand(stdio)).toBeNull();
  });

  it('signInCommand is null for a URL or header that is not printable ASCII', () => {
    // The vault's file is not the person's to trust, and quotes protect the
    // shell parser, not the terminal: pasted, an ETX can abort the line and
    // a CR run what follows it, however the words are quoted.
    const attack = 'https://mcp.example.test/mcp#\u0003open -a Calculator\r';
    expect(signInCommand(http('jira', attack))).toBeNull();
    expect(signInCommand(http('jira', 'https://jira.test/mcp', { 'X-Note': attack }))).toBeNull();
    // C0 (ETX, CR, LF, TAB, and ESC, whose [201~ ends a bracketed paste
    // early), DEL, C1 (NEL, CSI), bidi and format characters, and a letter
    // outside ASCII: none gets a command.
    for (const bad of [
      '\u0003',
      '\r',
      '\u001b[201~',
      '\n',
      '\t',
      '\u007f',
      '\u0085',
      '\u009b',
      '\u202e',
      '\u2066',
      '\u200b',
      '\ufeff',
      '\u00e9',
    ]) {
      const url = `https://jira.test/mcp${bad}`;
      expect(signInCommand(http('jira', url))).toBeNull();
      expect(signInBlocker(http('jira', url))).toBe('entry');
      const value = http('jira', 'https://jira.test/mcp', { 'X-Note': `core${bad}` });
      expect(signInCommand(value)).toBeNull();
      expect(signInBlocker(value)).toBe('entry');
      const key = http('jira', 'https://jira.test/mcp', { [`X-Note${bad}`]: 'core' });
      expect(signInCommand(key)).toBeNull();
      expect(signInBlocker(key)).toBe('entry');
    }
    // Both ends of the range still get one: a space and a ~.
    expect(signInCommand(http('jira', 'https://jira.test/~team/mcp', { 'X-Note': 'a b' }))).toBe(
      "claude mcp add --transport http jira 'https://jira.test/~team/mcp' --header 'X-Note: a b'",
    );
  });

  it('signInBlocker names what keeps an entry from a command, and nothing for one that has it', () => {
    expect(signInBlocker(http('Gmail', 'https://gmail.example.test/mcp'))).toBeNull();
    expect(signInBlocker(http('toy.v2', 'https://x.test/mcp'))).toBe('name');
    expect(signInBlocker(http('jira', 'https://jira.test/mcp', { 'X-Retries': 3 }))).toBe('entry');
    expect(
      signInBlocker({
        name: 'linear',
        transport: 'stdio',
        url: '',
        command: 'npx',
        args: [],
        enabled: true,
        extra: {},
      }),
    ).toBe('stdio');
  });

  it('stateLabel says each state, and no row as not observed yet', () => {
    expect(stateLabel('working')).toBe('working');
    expect(stateLabel('needs_sign_in')).toBe('needs sign-in');
    expect(stateLabel('failed')).toBe('failed');
    expect(stateLabel('not_approved')).toBe('not approved');
    expect(stateLabel(null)).toBe('not observed yet');
  });
});

describe('connector approvals and presets (M69.1)', () => {
  /** One entry of connectors.json, as Settings parses it. */
  const parsed = (name: string, entry: unknown): ConnectorSpec =>
    parseConnectors(JSON.stringify({ servers: { [name]: entry } }))[0];

  it('replays the shared connector approvals', () => {
    // src-tauri/src/connectors.rs#replays_the_shared_connector_approvals
    // replays the SAME file, so the key Settings approves is the key the
    // run's merge looks for, case by case.
    expect(CONNECTOR_APPROVALS.format).toBe(1);
    expect(CONNECTOR_APPROVALS.cases.length).toBeGreaterThanOrEqual(20);
    for (const { name, entry, key } of CONNECTOR_APPROVALS.cases) {
      expect(approvalKey(parsed(name, entry)), JSON.stringify(entry)).toBe(key);
    }
  });

  it('httpOAuth is absent, refused or the sorted block', () => {
    expect(httpOAuth(parsed('toy', { transport: 'http', url: 'https://t.test/mcp' }))).toBe(
      undefined,
    );
    expect(httpOAuth(parsed('toy', { transport: 'http', oauth: {} }))).toBe(undefined);
    expect(httpOAuth(parsed('toy', { transport: 'http', oauth: { scopes: ['read'] } }))).toBe(null);
    expect(
      Object.keys(
        httpOAuth(parsed('toy', { transport: 'http', oauth: { scopes: 'a', clientId: 'b' } }))!,
      ),
    ).toEqual(['clientId', 'scopes']);
  });

  it('presets are http and https, unique by name and URL, and each is approvable', () => {
    expect(Object.isFrozen(CONNECTOR_PRESETS)).toBe(true);
    expect(CONNECTOR_PRESETS.map((p) => p.name)).toEqual(['linear', 'notion']);
    expect(new Set(CONNECTOR_PRESETS.map((p) => p.name)).size).toBe(CONNECTOR_PRESETS.length);
    expect(new Set(CONNECTOR_PRESETS.map((p) => p.url)).size).toBe(CONNECTOR_PRESETS.length);
    for (const preset of CONNECTOR_PRESETS) {
      const spec = presetSpec(preset);
      expect(spec.transport).toBe('http');
      expect(spec.enabled).toBe(true);
      expect(preset.url.startsWith('https://')).toBe(true);
      expect(approvalKey(spec)).toMatch(/^[0-9a-f]{64}$/);
      expect(signInCommand(spec)).not.toBeNull();
      // Each preset is a case in the shared file, so Rust merges what the
      // preset adds under the key Settings approves for it.
      const shared = CONNECTOR_APPROVALS.cases.find((c) => c.name === preset.name);
      expect(shared?.entry.url).toBe(preset.url);
      expect(approvalKey(spec)).toBe(shared?.key);
    }
    expect(presetSpec(CONNECTOR_PRESETS[0]).extra).toEqual({ oauth: { scopes: 'read write' } });
    expect(presetSpec(CONNECTOR_PRESETS[1]).extra).toEqual({});
  });

  it('presetHolder matches the name, or the URL past a trailing slash and host case', () => {
    const [linear] = CONNECTOR_PRESETS;
    const http = (name: string, url: string): ConnectorSpec => ({
      name,
      transport: 'http',
      url,
      command: '',
      args: [],
      enabled: false,
      extra: {},
    });
    expect(presetHolder(linear, [])).toBeUndefined();
    expect(presetHolder(linear, [http('issues', 'https://MCP.Linear.App/mcp/')])?.name).toBe(
      'issues',
    );
    expect(presetHolder(linear, [http('issues', 'https://mcp.linear.app/mcp')])?.name).toBe(
      'issues',
    );
    expect(presetHolder(linear, [http('linear', 'https://elsewhere.test/mcp')])?.name).toBe(
      'linear',
    );
    // Path case is identity, and only one trailing slash is spelling.
    expect(presetHolder(linear, [http('issues', 'https://mcp.linear.app/MCP')])).toBeUndefined();
    expect(presetHolder(linear, [http('issues', 'https://mcp.linear.app/mcp//')])).toBeUndefined();
  });

  it('signInCommand writes add-json carrying scopes for linear and add --transport http for notion', () => {
    const [linear, notion] = CONNECTOR_PRESETS;
    expect(signInCommand(presetSpec(linear))).toBe(
      `claude mcp add-json linear '{"type":"http","url":"https://mcp.linear.app/mcp","oauth":{"scopes":"read write"}}'`,
    );
    expect(signInCommand(presetSpec(notion))).toBe(
      'claude mcp add --transport http notion https://mcp.notion.com/mcp',
    );
  });

  it('signInCommand quotes a header value with a quote, and refuses a name with a space', () => {
    const spec = (name: string): ConnectorSpec => ({
      name,
      transport: 'http',
      url: 'https://toy.example.test/mcp',
      command: '',
      args: [],
      enabled: true,
      extra: {
        headers: { 'X-Note': "it's", Authorization: 'Bearer t' },
        oauth: { scopes: 'read', clientId: 'toy' },
      },
    });
    expect(signInCommand(spec('toy'))).toBe(
      `claude mcp add-json toy '{"type":"http","url":"https://toy.example.test/mcp","headers":{"Authorization":"Bearer t","X-Note":"it'\\''s"},"oauth":{"clientId":"toy","scopes":"read"}}'`,
    );
    expect(signInCommand(spec('-dash'))).toMatch(/^claude mcp add-json -- -dash '\{/);
    // Claude Code adds a server only under letters, digits, - and _.
    expect(signInCommand(spec('my toy'))).toBeNull();
    expect(signInBlocker(spec('my toy'))).toBe('name');
    // An oauth Claude Code would refuse never reaches a run: no command.
    const refused = { ...spec('toy'), extra: { oauth: { scopes: '' } } };
    expect(signInCommand(refused)).toBeNull();
    expect(approvalKey(refused)).toBeNull();
  });

  it('removalNote names the entry for http and is null for stdio', () => {
    expect(removalNote(presetSpec(CONNECTOR_PRESETS[0]))).toBe(
      'Removed linear. Claude Code keeps the sign-in it stored for linear in your keychain; Cerebro never held it. To sign out, run claude, type /mcp, pick linear and clear its authentication.',
    );
    expect(
      removalNote({
        name: 'toy',
        transport: 'stdio',
        url: '',
        command: 'npx',
        args: [],
        enabled: true,
        extra: {},
      }),
    ).toBeNull();
  });
});

describe('M96.4a explicit connector ownership admission', () => {
  const routes = (): ConnectorSpec[] =>
    parseConnectors(
      JSON.stringify({
        servers: {
          'm96-http': {
            transport: 'http',
            url: 'https://m96-route.example.test/mcp',
            enabled: true,
            headers: { Authorization: 'm96-header-sentinel' },
            oauth: { scopes: 'read write' },
            timeout: 5000,
          },
          'm96-stdio': {
            transport: 'stdio',
            command: 'm96-unexecuted-command',
            args: ['m96-arg-sentinel'],
            env: { TOKEN: 'm96-env-sentinel' },
            enabled: true,
          },
        },
      }),
    );
  const withMarker = (spec: ConnectorSpec, marker: Record<string, unknown>): ConnectorSpec => ({
    ...spec,
    extra: { ...spec.extra, ...marker },
  });
  const invalidOwners: unknown[] = [null, 7, true, '', 'Cerebro', 'CLI', 'unknown', [], {}];
  const references: unknown[] = [
    null,
    7,
    false,
    '',
    'm96-reference-sentinel',
    [],
    { opaque: 'm96-reference-sentinel' },
  ];

  function noRawHelpers(spec: ConnectorSpec) {
    expect(approvalKey(spec)).toBeNull();
    expect(httpApprovalKey(spec)).toBeNull();
    expect(stdioApprovalKey(spec)).toBeNull();
    expect(signInBlocker(spec)).not.toBeNull();
    expect(signInCommand(spec)).toBeNull();
    const note = removalNote(spec);
    expect(note ?? '').not.toMatch(/never held|run claude|\/mcp/i);
  }

  it('m96_owner_direct_key_and_signin_helpers_cannot_bypass_managed_ownership', () => {
    for (const legacy of routes()) {
      expect(approvalKey(legacy)).toMatch(/^[0-9a-f]{64}$/);
      if (legacy.transport === 'http')
        expect(signInCommand(legacy)).toContain('claude mcp add-json');
      for (const enabled of [true, false]) {
        for (const marker of [
          { executionOwner: 'cerebro' },
          ...references.map((secretRef) => ({ executionOwner: 'cerebro', secretRef })),
        ]) {
          noRawHelpers({ ...withMarker(legacy, marker), enabled });
        }
      }
    }
  });

  it('m96_owner_invalid_marker_values_fail_closed_in_exported_helpers', () => {
    for (const legacy of routes()) {
      expect(approvalKey(legacy)).not.toBeNull();
      for (const executionOwner of invalidOwners)
        noRawHelpers(withMarker(legacy, { executionOwner }));
    }
  });

  it('m96_owner_orphan_reference_never_falls_back_to_cli_helpers', () => {
    for (const legacy of routes()) {
      for (const secretRef of references) {
        noRawHelpers(withMarker(legacy, { secretRef }));
        noRawHelpers(withMarker(legacy, { executionOwner: 'cli', secretRef }));
      }
    }
  });

  it('m96_owner_explicit_cli_preserves_legacy_keys_and_signin_without_granting_approval', () => {
    for (const legacy of routes()) {
      const explicit = withMarker(legacy, { executionOwner: 'cli' });
      expect(approvalKey(explicit)).toBe(approvalKey(legacy));
      expect(httpApprovalKey(explicit)).toBe(httpApprovalKey(legacy));
      expect(stdioApprovalKey(explicit)).toBe(stdioApprovalKey(legacy));
      expect(signInCommand(explicit)).toBe(signInCommand(legacy));
      expect(removalNote(explicit)).toBe(removalNote(legacy));
    }
  });

  it('m96_owner_sibling_serialization_retains_marked_fields_and_unknown_values', () => {
    const original = {
      servers: {
        managed: {
          transport: 'http',
          url: 'https://managed.example.test/mcp',
          enabled: true,
          executionOwner: 'cerebro',
          secretRef: { opaque: 'm96-reference-sentinel' },
          headers: { Authorization: 'm96-header-sentinel' },
          custom: { nested: [null, 3, 'kept'] },
        },
        invalid: {
          transport: 'stdio',
          command: 'm96-unexecuted-command',
          enabled: false,
          executionOwner: { malformed: true },
          secretRef: null,
          unknown: ['kept'],
        },
        sibling: { transport: 'http', url: 'https://sibling.example.test/mcp', enabled: true },
      },
    };
    const specs = parseConnectors(JSON.stringify(original));
    const saved: unknown = JSON.parse(
      serializeConnectors(
        specs.map((spec) => (spec.name === 'sibling' ? { ...spec, enabled: false } : spec)),
      ),
    );
    expect(saved).toEqual({
      servers: {
        ...original.servers,
        sibling: { ...original.servers.sibling, enabled: false },
      },
    });
    expect(readConnectorList('{not json')).toEqual({ kind: 'unreadable' });
    const onlyManaged = readConnectorList(
      JSON.stringify({ servers: { managed: original.servers.managed } }),
    );
    expect(onlyManaged.kind).toBe('specs');
    if (onlyManaged.kind !== 'specs') throw new Error('readable marked list must retain its row');
    expect(onlyManaged.specs).toHaveLength(1);
    expect(approvalKey(onlyManaged.specs[0])).toBeNull();
  });
});
