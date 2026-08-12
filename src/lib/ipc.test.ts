// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const { invokeSpy } = vi.hoisted(() => ({ invokeSpy: vi.fn(async () => [] as unknown) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeSpy }));

import {
  canPickFiles,
  importAttachment,
  ingestItemState,
  ledgerHead,
  ledgerStatus,
  scanVault,
  updateFrontmatter,
} from './ipc';

afterEach(() => {
  invokeSpy.mockClear();
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
});

describe('ipc backend detection', () => {
  it('delegates to the mock when not running inside Tauri', async () => {
    const entries = await scanVault('/demo-vault');
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it('invokes Tauri commands when __TAURI_INTERNALS__ is present', async () => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    await scanVault('/my-vault');
    expect(invokeSpy).toHaveBeenCalledWith('scan_vault', { vault: '/my-vault' });
    await updateFrontmatter('/my-vault', 'items/a.md', { status: 'done' });
    expect(invokeSpy).toHaveBeenCalledWith('update_frontmatter', {
      vault: '/my-vault',
      path: 'items/a.md',
      patch: { status: 'done' },
    });
  });
});

/**
 * `canPickFiles` is not cosmetic (M16.13c): a browser build has no native
 * picker, and `pickFiles` returning [] there is indistinguishable from the
 * user cancelling. The Files field branches on this to decide between
 * offering the typed-path fallback and doing nothing at all.
 */
describe('attachment IPC', () => {
  it('reports no native picker outside Tauri, and one inside it', () => {
    expect(canPickFiles()).toBe(false);
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    expect(canPickFiles()).toBe(true);
  });

  it('passes the absolute source through and lets the backend choose the folder', async () => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    await importAttachment('/my-vault', '/Users/me/report.pdf');
    expect(invokeSpy).toHaveBeenCalledWith('import_attachment', {
      vault: '/my-vault',
      source: '/Users/me/report.pdf',
    });
  });
});

// M21.7 parity: the command exists on both sides; the browser mock has no
// ledger and says so with null — never with guard logic.
describe('ledger head IPC', () => {
  it('returns null from the mock outside Tauri', async () => {
    expect(await ledgerHead('/demo-vault')).toBeNull();
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it('invokes ledger_head inside Tauri', async () => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    await ledgerHead('/my-vault');
    expect(invokeSpy).toHaveBeenCalledWith('ledger_head', { vault: '/my-vault' });
  });
});

// M26.4j parity: the command exists on both sides, and the mock's `null` is
// the SAME answer the real backend gives a vault whose ambient ingest has
// never run. Simulating a scheduler here would be a second implementation of
// a durable Rust table — and it would let a browser test claim a queue state
// no database ever held.
describe('ingest item state IPC', () => {
  it('returns null from the mock outside Tauri', async () => {
    expect(await ingestItemState('/demo-vault', 'records/a.md')).toBeNull();
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it('invokes ingest_item_state inside Tauri', async () => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    await ingestItemState('/my-vault', 'records/a.md');
    expect(invokeSpy).toHaveBeenCalledWith('ingest_item_state', {
      vault: '/my-vault',
      path: 'records/a.md',
    });
  });
});

// M21.8 parity: same rule as ledger_head — the command exists on both
// sides; the mock's answer is the fixed no-ledger verdict.
describe('ledger status IPC', () => {
  it('returns the fixed no-ledger verdict from the mock outside Tauri', async () => {
    const status = await ledgerStatus('/demo-vault');
    expect(status.verdict).toBe('no-ledger');
    expect(status.seq).toBeNull();
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it('invokes ledger_status inside Tauri', async () => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    await ledgerStatus('/my-vault');
    expect(invokeSpy).toHaveBeenCalledWith('ledger_status', { vault: '/my-vault' });
  });
});
