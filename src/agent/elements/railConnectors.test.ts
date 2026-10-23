import { describe, expect, it } from 'vitest';
import type { RunReach } from '@/agent/types';
import { approvalKey, parseConnectors, type ConnectorStatusRow } from '@/engine/connectors';
import { connectorRow, type ConnectorStatusRead } from './connectorRow';
import {
  RAIL_CONNECTORS_WORDS,
  railConnectors,
  type ConnectorListRead,
  type RailConnectorsInput,
} from './railConnectors';

/**
 * The rail's Connectors card (M92.9): the vault's list in Settings' words,
 * joined with what the conversation's latest run said it reaches (M92.8).
 */

const VAULT = '/vault';

const LIST = JSON.stringify({
  servers: {
    Gmail: { transport: 'http', url: 'https://gmail.example.test/mcp', enabled: true },
    jira: { transport: 'http', url: 'https://jira.example.test/mcp', enabled: true },
    slack: { transport: 'http', url: 'https://slack.example.test/mcp', enabled: false },
  },
});

/** Every entry of `raw` approved on this machine. */
const approved = (raw: string) => parseConnectors(raw).flatMap((spec) => approvalKey(spec) ?? []);

const row = (connector: string, over: Partial<ConnectorStatusRow> = {}): ConnectorStatusRow => ({
  connector,
  cli_name: connector,
  refused: null,
  state: null,
  signal: null,
  seen_at: null,
  run_id: null,
  ...over,
});

const reachOf = (over: Partial<RunReach> = {}): RunReach => ({
  connectors: [],
  missing: [],
  missing_more: 0,
  inherits: false,
  permission_mode: 'acceptEdits',
  cerebro: true,
  families: {},
  ...over,
});

const listed = (raw: string): ConnectorListRead => ({ kind: 'ready', raw });
const status = (...rows: ConnectorStatusRow[]): ConnectorStatusRead => ({ kind: 'ready', rows });

function input(over: Partial<RailConnectorsInput> = {}): RailConnectorsInput {
  return {
    vault: VAULT,
    enabled: true,
    list: listed(LIST),
    status: status(row('Gmail', { state: 'working' }), row('jira', { state: 'needs_sign_in' })),
    approvals: approved(LIST),
    reach: reachOf({ connectors: [{ name: 'Gmail', status: 'connected' }] }),
    ...over,
  };
}

describe('railConnectors', () => {
  it('lists the vault’s connectors in Settings’ words, joined with what the run loaded', () => {
    const view = railConnectors(input());
    expect(view.state).toBe('ready');
    expect(view.count).toBe('1 loaded');
    expect(view.lines.map((line) => [line.name, line.status, line.words, line.run])).toEqual([
      ['Gmail', 'working', 'working', 'loaded'],
      ['jira', 'needs_sign_in', 'needs sign-in', 'not-loaded'],
      ['slack', 'off', 'off', 'not-loaded'],
    ]);
    expect(view.lines.map((line) => line.facts)).toEqual([
      RAIL_CONNECTORS_WORDS.loaded,
      RAIL_CONNECTORS_WORDS.notLoaded,
      RAIL_CONNECTORS_WORDS.notLoaded,
    ]);
    expect(view.lines.map((line) => line.signIn)).toEqual([false, true, false]);
  });

  it('says each status in the words Settings derives for it', () => {
    const given = input();
    const view = railConnectors(given);
    for (const spec of parseConnectors(LIST)) {
      const settings = connectorRow(spec, given.approvals, given.status).status;
      const line = view.lines.find((one) => one.name === spec.name);
      expect([line?.status, line?.words]).toEqual([settings.key, settings.words]);
    }
  });

  it('names what the run did not get in Rust’s words, verbatim, listed or not', () => {
    const reason = 'its oauth or timeout is not one Claude Code accepts';
    const view = railConnectors(
      input({
        reach: reachOf({
          connectors: [{ name: 'Gmail', status: 'connected' }],
          missing: [
            { name: 'jira', reason: 'not approved on this machine' },
            { name: 'linear', reason: "not in this vault's connector list" },
            { name: 'notion', reason },
          ],
          missing_more: 2,
        }),
      }),
    );
    expect(view.lines.map((line) => [line.name, line.status, line.run, line.facts])).toEqual([
      ['Gmail', 'working', 'loaded', RAIL_CONNECTORS_WORDS.loaded],
      ['jira', 'needs_sign_in', 'missing', 'Not loaded: not approved on this machine'],
      ['slack', 'off', 'not-loaded', RAIL_CONNECTORS_WORDS.notLoaded],
      ['linear', 'unlisted', 'missing', "Not loaded: not in this vault's connector list"],
      ['notion', 'unlisted', 'missing', `Not loaded: ${reason}`],
    ]);
    expect(view.lines.find((line) => line.name === 'linear')?.words).toBeNull();
    expect(view.more).toBe('2 more connectors its instructions name not loaded');
  });

  it('says that mail is drafted, never sent, wherever a run merged a connector', () => {
    expect(railConnectors(input()).mail).toBe(true);
    expect(RAIL_CONNECTORS_WORDS.mail).toBe(
      'Mail is drafted, never sent: Cerebro blocks the known send tools by name.',
    );
    expect(railConnectors(input({ reach: reachOf() })).mail).toBe(false);
    expect(railConnectors(input({ reach: null })).mail).toBe(false);
  });

  it('is one quiet line when Settings switches connectors off, and reads nothing for it', () => {
    const view = railConnectors(
      input({ enabled: false, list: { kind: 'loading' }, status: { kind: 'loading' } }),
    );
    expect(view.state).toBe('empty');
    expect(view.none).toBe(RAIL_CONNECTORS_WORDS.off);
    expect(view.lines).toEqual([]);
    expect(view.mail).toBe(false);
  });

  it('makes no claim while a read is out', () => {
    expect(railConnectors(input({ list: { kind: 'loading' } })).state).toBeNull();
    expect(railConnectors(input({ status: { kind: 'loading' } })).state).toBeNull();
  });

  it('is unavailable, never empty, when the list could not be read', () => {
    const view = railConnectors(
      input({ list: { kind: 'unavailable', reason: '.cerebro is a symlink' } }),
    );
    expect(view.state).toBe('unavailable');
    expect(view.reason).toBe('.cerebro is a symlink');
    expect(view.lines).toEqual([]);
    expect(RAIL_CONNECTORS_WORDS.unavailableDetail(view.reason ?? '')).toBe(
      'Runs reach no connectors until it can be read: .cerebro is a symlink',
    );
  });

  it('is partial when the status read failed, its rows saying no state', () => {
    const view = railConnectors(
      input({ status: { kind: 'unavailable', reason: 'no runtime database' } }),
    );
    expect(view.state).toBe('partial');
    expect(view.lines.map((line) => [line.name, line.status, line.words])).toEqual([
      ['Gmail', 'unavailable', null],
      ['jira', 'unavailable', null],
      ['slack', 'off', 'off'],
    ]);
    expect(view.lines.some((line) => line.signIn)).toBe(false);
  });

  it('is not recorded for a conversation whose runs never said what they reach', () => {
    const view = railConnectors(input({ reach: null }));
    expect(view.state).toBe('not-recorded');
    expect(view.count).toBeUndefined();
    expect(view.lines.map((line) => [line.name, line.words, line.run, line.facts])).toEqual([
      ['Gmail', 'working', null, null],
      ['jira', 'needs sign-in', null, null],
      ['slack', 'off', null, null],
    ]);
  });

  it('names the inherited-connector limit where the vault has no list', () => {
    const view = railConnectors(
      input({ list: listed(''), status: status(), reach: reachOf({ inherits: true }) }),
    );
    expect(view.state).toBe('ready');
    expect(view.inherited).toBe(true);
    expect(view.lines).toEqual([]);
    expect(RAIL_CONNECTORS_WORDS.inherited).toContain('Cerebro never learns their names');
    expect(RAIL_CONNECTORS_WORDS.inherited).toContain('cannot block their send tools by name');
    // No run recorded yet: a turn you watch would load them all the same.
    const unrecorded = railConnectors(input({ list: listed(''), status: status(), reach: null }));
    expect([unrecorded.state, unrecorded.inherited]).toEqual(['not-recorded', true]);
    // A run pinned away from them says nothing of them.
    const pinned = railConnectors(input({ list: listed(''), status: status(), reach: reachOf() }));
    expect([pinned.state, pinned.inherited, pinned.none]).toEqual([
      'empty',
      false,
      RAIL_CONNECTORS_WORDS.none,
    ]);
  });

  it('is empty for a list that names nothing, when the run reached nothing', () => {
    const empty = JSON.stringify({ servers: {} });
    const view = railConnectors(input({ list: listed(empty), approvals: [], reach: reachOf() }));
    expect(view.state).toBe('empty');
    expect(view.inherited).toBe(false);
  });

  it('draws nothing with no vault', () => {
    expect(railConnectors(input({ vault: null })).state).toBe('empty');
  });
});
