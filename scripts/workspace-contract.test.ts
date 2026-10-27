// @vitest-environment jsdom
import { resolve } from 'node:path';
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import CASES from '../shared/workspace/legacy-source-cases.v1.json';
import { readNoteSource } from '../src/lib/ipc';
import type { LegacyRecordSnapshot } from '../src/lib/generated/workspace';
import { resetMockFs } from '../src/lib/mockIpc';
import { generateContract } from './contracts/generate';

vi.mock('../src/lib/mockSheet', () => ({}));

beforeEach(() => resetMockFs());

describe('workspace legacy read contract', () => {
  it('keeps the generated projection in sync with the Rust-owned schema', async () => {
    await generateContract(
      resolve('shared/workspace/contracts.v1.json'),
      resolve('src/lib/generated/workspace.ts'),
      true,
    );
  });

  it.each(CASES.reads)('reads exact shared source and hash: $name', async ({ path, expected }) => {
    const files = (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
    files.set(path, expected.content);
    const source = await readNoteSource('/demo-vault', path);
    expectTypeOf(source).toEqualTypeOf<LegacyRecordSnapshot>();
    expect(source).toEqual(expected);
    expect(files.get(path)).toBe(expected.content);
  });

  it.each(CASES.refusedPaths)('refuses the existing non-note target: %s', async (path) => {
    const files = (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
    files.set(path, 'bytes that must not be returned');
    await expect(readNoteSource('/demo-vault', path)).rejects.toThrow();
  });

  it('does not replace an unavailable read with a success-shaped empty source', async () => {
    await expect(readNoteSource('/demo-vault', CASES.unavailablePath)).rejects.toThrow();
  });
});
