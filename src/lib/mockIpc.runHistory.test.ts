import { beforeEach, describe, expect, it } from 'vitest';
import * as mock from './mockIpc';

function run(id: string, over: Partial<mock.FleetRun> = {}): mock.FleetRun {
  return {
    run_id: id,
    actor: 'process:scout',
    vault_id: 'vault-one-id',
    mode: 'ambient',
    lane: 'filed',
    started_at: '2026-10-23T10:00:00Z',
    ended_at: null,
    outcome: 'running',
    usage_state: 'pending',
    input_tokens: 0,
    output_tokens: 0,
    proposals_submitted: null,
    applied: null,
    rejected: null,
    parent_run_id: null,
    cause: null,
    cli_session_id: null,
    ...over,
  };
}
const scope = { kind: 'agent', vault: '/one', actor: 'process:scout' } as const;

describe('scoped fleet history', () => {
  beforeEach(() => {
    mock.resetMockFs();
    mock.__seedRunHistoryRegistry({ '/one': 'vault-one-id', '/two': 'vault-two-id' });
  });

  it('filters actor and authoritative vault identity before the limit, including hop anchors', async () => {
    mock.__seedFleet([
      ...Array.from({ length: 250 }, (_, n) => run(`other-${n}`, { actor: 'process:other' })),
      run('other-vault', { vault_id: 'vault-two-id' }),
      run('path-is-not-an-id', { vault_id: '/one' }),
      run('old-hop', { started_at: '2025-01-01', parent_run_id: 'other-1' }),
    ]);
    const result = await mock.scopedFleetRunsPage(scope);
    expect(result.runs.map((r) => r.run_id)).toEqual(['old-hop']);
    expect(result.runs[0].parent_run_id).toBe('other-1');
    expect(result.effectiveVaultIds).toEqual(['vault-one-id']);
    expect(result.nextCursor).toBeNull();
  });

  it('uses a strict descending tuple cursor across equal timestamps', async () => {
    mock.__seedFleet(['a', 'b', 'c', 'd', 'e'].map((id) => run(id)));
    const first = await mock.scopedFleetRunsPage(scope, undefined, 2);
    const second = await mock.scopedFleetRunsPage(scope, first.nextCursor!, 2);
    const third = await mock.scopedFleetRunsPage(scope, second.nextCursor!, 2);
    expect(first.runs.map((r) => r.run_id)).toEqual(['e', 'd']);
    expect(first.nextCursor).toEqual({ startedAt: '2026-10-23T10:00:00Z', runId: 'd' });
    expect(second.runs.map((r) => r.run_id)).toEqual(['c', 'b']);
    expect(third.runs.map((r) => r.run_id)).toEqual(['a']);
    expect(third.nextCursor).toBeNull();
  });

  it('bounds pages independently and only includes registered vaults in explicit construct scope', async () => {
    mock.__seedFleet([
      ...Array.from({ length: 260 }, (_, n) => run(`row-${n.toString().padStart(3, '0')}`)),
      run('vault-two', { vault_id: 'vault-two-id' }),
      run('unregistered', { vault_id: 'removed' }),
      run('unknown', { vault_id: null }),
    ]);
    expect((await mock.scopedFleetRunsPage(scope)).runs).toHaveLength(50);
    expect((await mock.scopedFleetRunsPage(scope, undefined, 999)).runs).toHaveLength(200);
    const result = await mock.scopedFleetRunsPage({
      kind: 'construct',
      actor: scope.actor,
      vault: 'all_registered',
    });
    expect(result.effectiveVaultIds).toEqual(['vault-one-id', 'vault-two-id']);
    expect(result.runs.some((r) => r.run_id === 'vault-two')).toBe(true);
    expect(result.runs.some((r) => r.run_id === 'unregistered' || r.run_id === 'unknown')).toBe(
      false,
    );
  });

  it('refuses unknown or unavailable registry identities rather than returning empty history', async () => {
    mock.__seedFleet([]);
    await expect(mock.scopedFleetRunsPage({ ...scope, vault: '/missing' })).rejects.toThrow();
    mock.__seedRunHistoryRegistry(null);
    await expect(mock.scopedFleetRunsPage(scope)).rejects.toThrow();
  });

  it('reads cross-actor and cross-vault descendants without adding them to matching anchors', async () => {
    mock.__seedFleet([
      run('root'),
      run('child', { actor: 'process:other', vault_id: 'vault-two-id', parent_run_id: 'root' }),
      run('grandchild', { actor: null, vault_id: null, parent_run_id: 'child' }),
    ]);
    expect((await mock.scopedFleetRunsPage(scope)).runs.map((r) => r.run_id)).toEqual(['root']);
    const result = await mock.fleetRunLineage('root');
    expect(result.runs.map((r) => [r.run_id, r.actor, r.vault_id])).toEqual([
      ['child', 'process:other', 'vault-two-id'],
      ['grandchild', null, null],
    ]);
    expect(result.truncated).toBe(false);
  });

  it('excludes the anchor, terminates cycles once, and reports capped descendants', async () => {
    mock.__seedFleet([
      run('root', { parent_run_id: 'child' }),
      run('child', { parent_run_id: 'root' }),
    ]);
    expect((await mock.fleetRunLineage('root')).runs.map((r) => r.run_id)).toEqual(['child']);
    mock.__seedFleet([
      run('root'),
      ...Array.from({ length: 201 }, (_, n) => run(`child-${n}`, { parent_run_id: 'root' })),
    ]);
    const result = await mock.fleetRunLineage('root');
    expect(result.runs).toHaveLength(200);
    expect(new Set(result.runs.map((r) => r.run_id)).size).toBe(200);
    expect(result.truncated).toBe(true);
    await expect(mock.fleetRunLineage('missing')).rejects.toThrow();
  });

  it('retains the traversal prefix at the cap rather than dropping a descendant ancestor', async () => {
    mock.__seedFleet([
      run('root'),
      ...Array.from({ length: 201 }, (_, n) =>
        run(`node-${n}`, {
          parent_run_id: n === 0 ? 'root' : `node-${n - 1}`,
          started_at: `2026-10-23T${n.toString().padStart(3, '0')}`,
        }),
      ),
    ]);
    const result = await mock.fleetRunLineage('root');
    expect(result.runs[0].run_id).toBe('node-0');
    expect(result.runs.at(-1)!.run_id).toBe('node-199');
    expect(result.truncated).toBe(true);
  });

  it('resolves origins through the registry without confusing absent and unavailable', async () => {
    expect(await mock.fleetRunOrigin('vault-two-id')).toEqual({
      kind: 'registered',
      vault: '/two',
    });
    expect(await mock.fleetRunOrigin('/two')).toEqual({ kind: 'unavailable' });
    expect(await mock.fleetRunOrigin('removed')).toEqual({ kind: 'unavailable' });
    expect(await mock.fleetRunOrigin(null)).toEqual({ kind: 'not_recorded' });
    mock.__seedRunHistoryRegistry(null);
    await expect(mock.fleetRunOrigin('vault-one-id')).rejects.toThrow();
  });

  it('refuses malformed pagination identities and clamps zero to an advancing page', async () => {
    mock.__seedFleet([run('a'), run('b')]);
    expect(
      (await mock.scopedFleetRunsPage(scope, undefined, 0)).runs.map((row) => row.run_id),
    ).toEqual(['b']);
    await expect(mock.scopedFleetRunsPage({ ...scope, actor: '' })).rejects.toThrow();
    await expect(mock.scopedFleetRunsPage({ ...scope, actor: '界'.repeat(342) })).rejects.toThrow();
    await expect(mock.scopedFleetRunsPage(scope, { startedAt: '', runId: 'a' })).rejects.toThrow();
    await expect(
      mock.scopedFleetRunsPage(scope, { startedAt: '2026', runId: '' }),
    ).rejects.toThrow();
    await expect(mock.scopedFleetRunsPage(scope, undefined, -1)).rejects.toThrow();
    await expect(mock.scopedFleetRunsPage(scope, undefined, 1.5)).rejects.toThrow();
  });

  it('keeps a missing runtime unavailable even if a registry fixture remains', async () => {
    mock.__seedFleet(null);
    await expect(mock.fleetRunOrigin('vault-one-id')).rejects.toThrow();
  });
});
