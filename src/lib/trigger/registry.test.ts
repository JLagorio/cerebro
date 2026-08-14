/**
 * The TS half of the trigger-registry parity contract (M28.0). The Rust twin
 * is `src-tauri/src/trigger/registry.rs`; both interpret the same artifact
 * bytes, and these tests pin the same shipped content the Rust tests pin, so
 * a drifted loader fails on whichever side drifted.
 */

import { describe, expect, it } from 'vitest';

import raw from '../../../shared/policy/trigger-registry.v1.json';
import { loadRegistry, parseRegistry, resolveGate, resolveGateKey, REGISTRY_IDS } from './registry';

type Mutable = ReturnType<typeof structuredClone<typeof raw>>;

function mutated(mutate: (value: Mutable) => void): () => void {
  const copy = structuredClone(raw);
  mutate(copy);
  return () => parseRegistry(copy);
}

describe('the shipped artifact', () => {
  it('loads, and pins the design constants verbatim', () => {
    const registry = loadRegistry();
    expect(registry.ruleVersion).toBe('trigger-registry-v1');
    expect(registry.evaluationIdDomain).toBe('cerebro-trigger-evaluation-v1');
    expect(registry.snapshotHashDomain).toBe('cerebro-trigger-snapshot-v1');
    expect(registry.evidenceRoot).toBe('docs/superpowers/evidence/triggers');
    expect(registry.protectedNames).toEqual([
      'Skeptic',
      'Scout',
      'Curiosity',
      'Claim',
      'Discovery',
      'Forecast',
      'Narrative',
    ]);
  });

  it('declares exactly the closed mode map', () => {
    const registry = loadRegistry();
    for (const id of ['R1', 'R3', 'R6', 'R7', 'R10', 'R13']) {
      const gate = resolveGate(registry, id, 'root');
      expect(gate?.variant, id).toBe('measurable');
      expect(gate?.parent, id).toBeNull();
    }
    expect(resolveGate(registry, 'R2', 'root')?.variant).toBe('hybrid');
    for (const id of ['R8', 'R9', 'R11']) {
      expect(resolveGate(registry, id, 'root')?.variant, id).toBe('discretionary');
    }
    for (const id of REGISTRY_IDS) {
      const expected = id === 'R1' || id === 'R2' ? 'subscription_global' : 'vault_store';
      expect(registry.entries.find((e) => e.id === id)?.scope, id).toBe(expected);
    }
    for (const key of ['issue', 'risk', 'action', 'decision']) {
      const gate = resolveGate(registry, 'R4', key);
      expect(gate?.variant, key).toBe('discretionary');
      expect(gate?.parent, key).toBeNull();
    }
    for (const key of ['assumption', 'causal_hypothesis', 'forecast']) {
      expect(resolveGate(registry, 'R5', key)?.variant, key).toBe('discretionary');
    }
    const discovery = resolveGate(registry, 'R5', 'discovery');
    expect(discovery?.variant).toBe('measurable');
    expect(discovery?.parent).toEqual({
      kind: 'measurable_alias',
      allowed: ['R13:root'],
      requires_result: 'fired',
      byte_equal: ['window', 'input_snapshot_refs', 'input_snapshot_hash', 'metrics', 'result'],
    });
    const r12 = registry.entries.find((e) => e.id === 'R12');
    expect(r12?.subcapabilities).toHaveLength(16);
    expect(resolveGateKey(registry, 'R12:per_connector_scope_model')?.parent).toEqual({
      kind: 'fired_parent',
      allowed: ['R14:connector:*'],
    });
    // R14 registers no connectors yet, so no connector key resolves. That is
    // the shipped truth, not a placeholder.
    expect(resolveGate(registry, 'R14', 'connector:github')).toBeNull();
    expect(resolveGate(registry, 'R14', 'root')).toBeNull();
  });

  it('refuses every combination the map does not name', () => {
    const registry = loadRegistry();
    const universe = new Set<string>(['root', 'connector:github', 'connector:', 'issue ']);
    const declared = new Set<string>();
    for (const entry of registry.entries) {
      for (const sub of entry.subcapabilities) {
        universe.add(sub.key);
        declared.add(`${entry.id}:${sub.key}`);
      }
    }
    expect(declared.size).toBe(34);
    for (const entry of registry.entries) {
      for (const subkey of universe) {
        const resolved = resolveGate(registry, entry.id, subkey) !== null;
        expect(resolved, `${entry.id}:${subkey}`).toBe(declared.has(`${entry.id}:${subkey}`));
      }
    }
    expect(resolveGateKey(registry, 'no-colon')).toBeNull();
    expect(resolveGateKey(registry, 'R15:root')).toBeNull();
  });

  it('has protocols for exactly the unaliased measurable and hybrid gates', () => {
    const registry = loadRegistry();
    expect(Object.keys(registry.protocols).sort()).toEqual([
      'R10:root',
      'R13:root',
      'R1:root',
      'R2:root',
      'R3:root',
      'R6:root',
      'R7:root',
    ]);
  });
});

describe('a mutated artifact refuses', () => {
  it('when an entry is missing', () => {
    expect(mutated((v) => v.entries.splice(13, 1))).toThrow(/exactly/);
  });

  it('when a protocol covers a discretionary gate', () => {
    expect(
      mutated((v) => {
        (v.protocols as Record<string, unknown>)['R8:root'] = { window_days: 30 };
      }),
    ).toThrow(/exactly the unaliased measurable\/hybrid gates/);
  });

  it('when a measurable gate loses its protocol', () => {
    expect(
      mutated((v) => {
        delete (v.protocols as Record<string, unknown>)['R13:root'];
      }),
    ).toThrow(/exactly the unaliased measurable\/hybrid gates/);
  });

  it('when the aliased measurable is given its own protocol', () => {
    expect(
      mutated((v) => {
        (v.protocols as Record<string, unknown>)['R5:discovery'] = { window_days: 30 };
      }),
    ).toThrow(/exactly the unaliased measurable\/hybrid gates/);
  });

  it('when a parent names a gate the registry does not declare', () => {
    expect(
      mutated((v) => {
        (v.entries[11].subcapabilities[4].parent as { allowed: string[] }).allowed = ['R6:aliases'];
      }),
    ).toThrow(/which the registry does not declare/);
  });

  it('when an alias points at a non-measurable parent', () => {
    expect(
      mutated((v) => {
        (v.entries[4].subcapabilities[3].parent as { allowed: string[] }).allowed = ['R8:root'];
      }),
    ).toThrow(/must be an unaliased measurable gate/);
  });

  it('when a variant and its parent rule contradict each other', () => {
    expect(
      mutated((v) => {
        v.entries[1].subcapabilities[0].parent = {
          kind: 'fired_parent',
          allowed: ['R13:root'],
        } as never;
      }),
    ).toThrow(/cannot carry/);
  });

  it('when a ppm constant exceeds one million', () => {
    expect(
      mutated((v) => {
        (v.protocols['R2:root'] as Record<string, number>).min_unused_ppm = 1_000_001;
      }),
    ).toThrow(/exceeds 1_000_000 ppm/);
  });

  it('when a floor is zero', () => {
    expect(
      mutated((v) => {
        (v.protocols['R7:root'] as Record<string, number>).required_sources = 0;
      }),
    ).toThrow(/a floor of nothing is not a floor/);
  });

  it('when a metric unit is not closed', () => {
    expect(
      mutated((v) => {
        (v.metrics.quantity_units as Record<string, string>).gap_duration = 'hours';
      }),
    ).toThrow(/which is not closed/);
  });
});

describe('a registered connector', () => {
  it('resolves and carries the pattern rules, and only that connector', () => {
    const copy = structuredClone(raw);
    (copy.entries[13].subcapability_pattern?.registered_connectors as string[]).push('github');
    const registry = parseRegistry(copy);
    const gate = resolveGate(registry, 'R14', 'connector:github');
    expect(gate?.variant).toBe('discretionary');
    expect(gate?.scope).toBe('vault_store');
    expect(gate?.parent).toBeNull();
    expect(resolveGate(registry, 'R14', 'connector:gitlab')).toBeNull();
  });
});
