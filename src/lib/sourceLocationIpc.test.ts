// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceLocator } from '@/engine/sourceLocation';
import { sourceUtf8Length } from '@/engine/sourceLocation';
import { splitFrontmatter } from '@/engine/frontmatter';
import * as ipc from './ipc';
import { __seedRunHistoryRegistry, resetMockFs } from './mockIpc';
import { sha256Hex } from './sha256';
import cases from '../../shared/knowledge/source-location-cases.json';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
const VAULT = '/demo-vault';
const PATH = 'notes/source-location-fixture.md';
const RAW =
  '\ufeff---\r\nstatus_note: old\r\n---\t\r\n\r\n# Source\r\n\r\n😀 é [[Page|needle]] and needle again.\r\n';
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
function locator(raw = RAW): SourceLocator {
  const body = splitFrontmatter(raw).body;
  const at = body.indexOf('needle');
  return {
    version: 1,
    vaultId: 'demo',
    path: PATH,
    sourceHash: sha256Hex(raw),
    kind: 'body',
    bodyUtf8Range: {
      start: sourceUtf8Length(body.slice(0, at)),
      end: sourceUtf8Length(body.slice(0, at + 6)),
    },
    quote: 'needle',
    prefix: '[[Page|',
    suffix: ']]',
  };
}
beforeEach(() => {
  resetMockFs();
  __seedRunHistoryRegistry({ [VAULT]: 'demo', '/other': 'other-id' });
  fs().set(PATH, RAW);
  invoke.mockReset();
});
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe('source location IPC and mock', () => {
  it.each(cases.cases)('replays the shared raw-source case: $name', async (fixture) => {
    const recorded = fixture.locator as SourceLocator;
    fs().set(recorded.path, fixture.current);
    // The human mock has whole-vault access. Revoking its seeded registration
    // exercises scope-first refusal; per-path denial also runs in both cores.
    __seedRunHistoryRegistry(fixture.allowed ? { [VAULT]: fixture.vaultId } : {});
    const result = await ipc.resolveSource(VAULT, recorded);
    expect(result.status).toBe(fixture.status);
    if ('range' in fixture && (result.status === 'exact' || result.status === 'relocated'))
      expect(result.locator.bodyUtf8Range).toEqual(fixture.range);
    expect(fs().get(recorded.path)).toBe(fixture.current);
  });

  it('sends the literal vault and locator keys through the existing IPC adapter', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    invoke.mockResolvedValueOnce({ status: 'exact', locator: locator() });
    expect(await ipc.resolveSource(VAULT, locator())).toEqual({
      status: 'exact',
      locator: locator(),
    });
    expect(invoke).toHaveBeenCalledWith('resolve_source', { vault: VAULT, locator: locator() });
  });

  it('produces a raw full-file hash and valid UTF-8 span from the same Markdown read', async () => {
    const hit = (await ipc.searchVault(VAULT, 'needle', 50)).hits.find((row) => row.path === PATH)!;
    expect(hit.location?.sourceHash).toBe(sha256Hex(RAW));
    expect(hit.location?.vaultId).toBe('demo');
    const location = hit.location!;
    const body = splitFrontmatter(RAW).body;
    const encoded = new TextEncoder().encode(body);
    expect(
      new TextDecoder().decode(
        encoded.slice(location.bodyUtf8Range!.start, location.bodyUtf8Range!.end),
      ),
    ).toBe(location.quote);
    expect(await ipc.resolveSource(VAULT, location)).toEqual({
      status: 'exact',
      locator: location,
    });
    expect(fs().get(PATH)).toBe(RAW);
  });

  it('relocates a metadata-only edit while keeping the recorded selected occurrence', async () => {
    const recorded = locator();
    fs().set(PATH, RAW.replace('status_note: old', 'status_note: outside'));
    const result = await ipc.resolveSource(VAULT, recorded);
    expect(result).toEqual({
      status: 'relocated',
      previousHash: recorded.sourceHash,
      locator: { ...recorded, sourceHash: sha256Hex(fs().get(PATH)!) },
    });
  });

  it('reports ambiguous edited passages as changed and other vault identities as unavailable', async () => {
    fs().set(PATH, RAW + '\r\n[[Page|needle]]\r\n');
    expect((await ipc.resolveSource(VAULT, locator())).status).toBe('changed');
    const denied = await ipc.resolveSource('/other', locator());
    expect(denied.status).toBe('unavailable');
    expect(JSON.stringify(denied)).not.toContain('needle');
  });

  it('resolves the existing metadata row without inventing a body or array-member range', async () => {
    const raw = '---\npeople: [Ada, Grace]\nproject: "[[Launch]]"\n---\n# Source\n';
    fs().set(PATH, raw);
    const property: SourceLocator = {
      version: 1,
      vaultId: 'demo',
      path: PATH,
      sourceHash: sha256Hex(raw),
      kind: 'property',
      propertyKey: 'people',
      quote: 'Ada, Grace',
      prefix: '',
      suffix: '',
    };
    expect(await ipc.resolveSource(VAULT, property)).toEqual({
      status: 'exact',
      locator: property,
    });
    fs().set(PATH, raw.replace('Ada, Grace', 'Ada, Katherine'));
    expect((await ipc.resolveSource(VAULT, property)).status).toBe('changed');
  });

  it('does not invent Markdown locations for Mermaid or bodies outside the search cap', async () => {
    fs().set('diagram.mmd', 'graph TD\n A[needle] --> B[Done]\n');
    fs().set(PATH, '# Large\n' + 'x'.repeat(102400) + '\nneedle\n');
    const found = await ipc.searchVault(VAULT, 'needle', 50);
    expect(found.hits.find((row) => row.path === 'diagram.mmd')?.location).toBeUndefined();
    expect(found.hits.some((row) => row.path === PATH)).toBe(false);
    expect(found.capped).toBeGreaterThan(0);
  });

  it('refuses oversized source before metadata parsing and missing mock vault registration', async () => {
    fs().set(PATH, 'x'.repeat(8388609));
    expect((await ipc.resolveSource(VAULT, locator())).status).toBe('unavailable');
    __seedRunHistoryRegistry(null);
    expect((await ipc.resolveSource(VAULT, locator())).status).toBe('unavailable');
  });
});
