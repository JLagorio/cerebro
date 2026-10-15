import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sha256Hex } from '@/lib/sha256';
import { describe, expect, it } from 'vitest';
import type { ImportSources } from './importSources';
import {
  canonicalRecordId,
  composeImport,
  IMPORT_SOURCES,
  importPathRefusal,
  loadImportSources,
  storedImportHash,
  storedRecordId,
  stampRefusal,
  validImportUrl,
} from './importSources';

describe('shared source cases', () => {
  for (const row of IMPORT_SOURCES.cases.urls)
    it(`checks source URL ${JSON.stringify(row.input)}`, () => {
      expect(validImportUrl(row.input)).toBe(row.accepted);
    });
  for (const item of IMPORT_SOURCES.cases.record_ids)
    it(`canonicalizes ${item.system}: ${JSON.stringify(item.input)}`, () => {
      if (item.expected === null)
        expect(() => canonicalRecordId(item.system, item.input)).toThrow();
      else expect(canonicalRecordId(item.system, item.input)).toBe(item.expected);
    });
  for (const item of IMPORT_SOURCES.cases.import_hashes)
    it(`composes and hashes ${item.name} exactly`, () => {
      const got = composeImport(item.content, {
        system: item.system,
        recordId: item.record_id,
        ...(item.url === null ? {} : { url: item.url }),
        ...(item.method === null ? {} : { method: item.method }),
        now: item.now,
        actor: item.actor,
      });
      expect(got).toEqual({ content: item.composed, hash: item.hash });
      expect(storedImportHash(got.content)).toEqual({ stored: item.hash, current: item.hash });
      const later = composeImport(item.content, {
        system: item.system,
        recordId: item.record_id,
        ...(item.url === null ? {} : { url: item.url }),
        ...(item.method === null ? {} : { method: item.method }),
        now: '2027-01-01T00:00:00Z',
        actor: 'human:later',
      });
      expect(later.hash).toBe(got.hash);
    });
  for (const [i, item] of IMPORT_SOURCES.cases.stamps.entries())
    it(`reads stored stamp ${i}`, () => {
      expect(storedImportHash(item.content)?.stored ?? null).toBe(item.expected);
    });
});
it('does not hash an already-stamped calendar digest a second time', () => {
  const id = canonicalRecordId('ics', 'event-1 -');
  expect(storedRecordId('ics', id)).toBe(id);
  expect(storedRecordId('ics', 'event-1 -')).toBeNull();
});
it('refuses stamp-bearing content, reserved types, unsafe roots and invalid line carriers', () => {
  const stamp = {
    system: 'linear',
    recordId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    now: 'now',
    actor: 'human:me',
  };
  for (const key of [...IMPORT_SOURCES.cache.keys, ...IMPORT_SOURCES.import.keys])
    expect(() => composeImport(`---\n${key}: forged\n---\nbody`, stamp)).toThrow('Cerebro stamps');
  for (const type of ['Agent', ' TYPE ', 'skill', 'Collection'])
    expect(() => composeImport(`---\ntype: ${JSON.stringify(type)}\n---\nbody`, stamp)).toThrow(
      'never writes a type',
    );
  for (const content of [
    'body',
    '---\r\n---\r\nbody',
    '---\n[a,b]\n---\nbody',
    '---\na: [\n---\nbody',
  ])
    expect(() => composeImport(content, stamp)).toThrow('frontmatter');
  for (const path of [
    'knowledge/a.md',
    'Sources/a.md',
    '/a.md',
    '../a.md',
    '.secret/a.md',
    'records/a.txt',
    'a\\b.md',
  ])
    expect(importPathRefusal(path)).not.toBeNull();
  expect(importPathRefusal('records/a.md')).toBeNull();
});
it('holds unknown fields, repeated lists, source order and canonicalizer arguments closed', () => {
  const altered = (change: (row: ImportSources & { extra?: boolean }) => void) => {
    const row = structuredClone(IMPORT_SOURCES);
    change(row);
    return () => loadImportSources(row);
  };
  expect(
    altered((row) => {
      row.extra = true;
    }),
  ).toThrow('sources.extra: is not a field');
  expect(
    altered((row) => {
      row.format = 2;
    }),
  ).toThrow('sources.format: must be 1');
  expect(
    altered((row) => {
      row.cache.kinds.push('issue');
    }),
  ).toThrow('must not repeat');
  expect(
    altered((row) => {
      row.systems.reverse();
    }),
  ).toThrow('sorted lowercase');
  expect(
    altered((row) => {
      Object.assign(row.systems[0].id_steps[0], { op: 'invent' });
    }),
  ).toThrow('canonicalizer step');
  expect(
    altered((row) => {
      Object.assign(row.systems[0].id_steps[1], { max: 0 });
    }),
  ).toThrow('positive integer');
  expect(
    altered((row) => {
      row.stamp.order.reverse();
    }),
  ).toThrow('in order');
});

it('hashes to the digest the Rust reader also asserts', () => {
  const raw = readFileSync(resolve(__dirname, '../../shared/import/sources.v1.json'), 'utf8');
  expect(JSON.parse(raw)).toEqual(IMPORT_SOURCES);
  expect(sha256Hex(raw)).toBe(
    readFileSync(resolve(__dirname, '../../shared/import/sources.v1.sha256'), 'utf8').trim(),
  );
});

it('replays the stamp guard cases', () => {
  for (const row of IMPORT_SOURCES.cases.stamp_guard)
    expect(stampRefusal(row.before, row.after), row.name).toBe(row.refusal);
});
