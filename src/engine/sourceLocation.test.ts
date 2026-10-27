import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import cases from '../../shared/knowledge/source-location-cases.json';
import { splitFrontmatter } from './frontmatter';
import { resolveSourceWith, type SourceLocator } from './sourceLocation';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
describe('source-location shared cases', () => {
  for (const c of cases.cases) {
    it(c.name, () => {
      let reads = 0;
      expect(hash(c.original)).toBe(c.locator.sourceHash);
      const result = resolveSourceWith(
        { vaultId: c.vaultId, admits: () => c.allowed },
        c.locator as SourceLocator,
        () => {
          reads++;
          if (c.readUnavailable) return null;
          return {
            sourceHash: hash(c.current),
            body: splitFrontmatter(c.current).body,
            fields: c.currentFields,
            carrier: c.locator.path.endsWith('.md') ? 'markdown' : 'unsupported',
          };
        },
      );
      expect(result.status).toBe(c.status);
      if ('locator' in result) {
        expect(result.locator.bodyUtf8Range).toEqual(c.range);
        expect(result.locator.sourceHash).toBe(hash(c.current));
      }
      if (c.status === 'unavailable') {
        expect(reads).toBe(c.readUnavailable ? 1 : 0);
        expect(result).not.toHaveProperty('locator');
      }
    });
  }
});

it('rejects a quote beyond the bounded searched body', () => {
  const body = `${'x'.repeat(102400)}secret`;
  const locator: SourceLocator = {
    version: 1,
    vaultId: 'vault',
    path: 'note.md',
    sourceHash: hash(body),
    kind: 'body',
    bodyUtf8Range: { start: 102400, end: 102406 },
    quote: 'secret',
    prefix: '',
    suffix: '',
  };
  const result = resolveSourceWith({ vaultId: 'vault', admits: () => true }, locator, () => ({
    sourceHash: hash(body),
    body,
    fields: [],
    carrier: 'markdown',
  }));
  expect(result.status).toBe('changed');
});

it('refuses malformed paths before consulting a source reader', () => {
  const base = cases.cases[0].locator as SourceLocator;
  for (const path of [
    '../secret.md',
    '/secret.md',
    'a//secret.md',
    'a/./secret.md',
    'C:/secret.md',
    'a\\secret.md',
  ]) {
    const result = resolveSourceWith(
      { vaultId: 'vault', admits: () => true },
      { ...base, path },
      () => {
        throw new Error('A refused path reached the reader');
      },
    );
    expect(result.status).toBe('unavailable');
  }
});

it('loads the same source-location contract bytes as Rust', async () => {
  const { readFileSync } = await import('node:fs');
  const raw = readFileSync('shared/knowledge/source-location.v1.json', 'utf8');
  expect(hash(raw)).toBe(readFileSync('shared/knowledge/source-location.v1.sha256', 'utf8').trim());
});

it('builds a bounded raw window without splitting emoji or normalizing aliases', async () => {
  const { sourceLocatorForWindow, boundedSourceBody } = await import('./sourceLocation');
  const raw = 'See [[atlas|the plan]] 😀';
  const location = sourceLocatorForWindow('vault', 'note.md', hash(raw), raw, {
    start: 4,
    end: 22,
  });
  expect(location).toMatchObject({
    quote: '[[atlas|the plan]]',
    prefix: 'See ',
    suffix: ' 😀',
    bodyUtf8Range: { start: 4, end: 22 },
  });
  expect(
    sourceLocatorForWindow('vault', 'note.md', hash(raw), raw, { start: 24, end: 27 }),
  ).toBeNull();
  expect(boundedSourceBody(`${'x'.repeat(102399)}😀`)).toBe('x'.repeat(102399));
});

it('refuses C1 controls and oversized vault identities before reading', () => {
  const base = cases.cases[0].locator as SourceLocator;
  for (const locator of [
    { ...base, path: 'a\u0085.md' },
    { ...base, vaultId: 'v'.repeat(129) },
  ]) {
    expect(
      resolveSourceWith({ vaultId: locator.vaultId, admits: () => true }, locator, () => {
        throw new Error('An invalid address reached the reader');
      }).status,
    ).toBe('unavailable');
  }
});
