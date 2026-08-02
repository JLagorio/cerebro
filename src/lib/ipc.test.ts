// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const { invokeSpy } = vi.hoisted(() => ({ invokeSpy: vi.fn(async () => [] as unknown) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeSpy }));

import { scanVault, updateFrontmatter } from './ipc';

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
