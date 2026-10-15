import { describe, expect, it } from 'vitest';
import CASES from '../../src-tauri/fixtures/trash-cases.json';
import {
  KEEP_DAYS,
  MANIFEST,
  TRASH_DIR,
  TRASH_WORDS,
  UNREADABLE_ITEM,
  alreadyExists,
  deletedWhen,
  expired,
  manifestBytes,
  newStamp,
  notAPage,
  nothingAt,
  parseManifest,
  parseStamp,
  purgeWhen,
  type TrashManifest,
} from './trash';

describe('the vault Trash (M60.8)', () => {
  it('KEEP_DAYS, the folder and the manifest name equal the fixture', () => {
    expect(KEEP_DAYS).toBe(CASES.keep_days);
    expect(TRASH_DIR).toBe(CASES.trash_dir);
    expect(MANIFEST).toBe(CASES.manifest_name);
  });

  it("refuses in Rust's words", () => {
    expect(notAPage('{path}')).toBe(CASES.words.not_a_page);
    expect(alreadyExists('{path}')).toBe(CASES.words.exists);
    expect(UNREADABLE_ITEM).toBe(CASES.words.unreadable);
    expect(nothingAt('{stamp}')).toBe(CASES.words.nothing);
  });

  it('parses every stamp case as Rust does', () => {
    for (const c of CASES.stamps) {
      const at = parseStamp(c.name);
      expect(at === null ? null : at.toISOString().replace('.000Z', 'Z'), c.name).toBe(c.at);
    }
  });

  it('mints the stamps the fixture names', () => {
    for (const c of CASES.minted) expect(newStamp(new Date(c.at), c.rng)).toBe(c.name);
  });

  it('writes and reads manifests byte for byte', () => {
    for (const c of CASES.manifests) {
      const manifest = { format: 1, ...c.item } as TrashManifest;
      expect(manifestBytes(manifest)).toBe(c.bytes);
      expect(parseManifest(c.bytes)).toEqual(manifest);
    }
    for (const text of CASES.unreadable_manifests) expect(parseManifest(text), text).toBeNull();
  });

  it('expires by the stamp, past thirty days', () => {
    for (const c of CASES.purge) {
      expect(expired(parseStamp(c.stamp)!, new Date(c.now)), JSON.stringify(c)).toBe(c.moves);
    }
  });

  it('says when an item went and when it leaves', () => {
    const item = CASES.list.items[0] as Parameters<typeof deletedWhen>[0];
    expect(deletedWhen(item)?.toISOString()).toBe('2026-10-14T09:30:00.000Z');
    expect(purgeWhen(item)?.toISOString()).toBe('2026-11-13T09:30:00.000Z');
    expect(purgeWhen({ ...item, stamp: 'not a stamp' })).toBeNull();
    expect(deletedWhen({ ...item, deletedAt: '' })?.toISOString()).toBe('2026-10-14T09:30:00.000Z');
  });

  it('the words name the thirty days and never the system Trash', () => {
    expect(TRASH_WORDS.footer).toBe('Restore from Settings → Recently deleted for 30 days.');
    expect(TRASH_WORDS.hint).toContain('30 days');
    for (const words of Object.values(TRASH_WORDS)) {
      expect(words).not.toMatch(/system Trash|not from the app/);
    }
  });
});
