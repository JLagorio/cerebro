import { describe, expect, it } from 'vitest';
import RAW from '../../shared/files/bytes.v1.json';
import { FILE_BYTES, fileUrlFor, isFileRefusal, parseBytesRules, relRefusal } from './fileBytes';

describe('file bytes addresses', () => {
  it('replays the shared bytes cases', () => {
    for (const row of RAW.cases) {
      const result = fileUrlFor(row.root, row.rel, 'revision' in row ? row.revision : undefined);
      expect(typeof result === 'string' ? result : result.code).toBe(
        'url' in row ? row.url : row.refusal,
      );
    }
  });
  it('bounds UTF-8 bytes and refuses malformed strings without throwing', () => {
    expect(relRefusal('0', 'é'.repeat(FILE_BYTES.limits.rel_bytes / 2))).toBeNull();
    for (const path of ['é'.repeat(FILE_BYTES.limits.rel_bytes / 2 + 1), '\ud800', 'a\u0085.png'])
      expect(relRefusal('0', path)?.code).toBe('bad_address');
    expect(fileUrlFor('0', "a!'()*.png")).toBe('cerebro-file://localhost/0/a%21%27%28%29%2A.png');
  });
  it('permits only an opaque bounded cache revision', () => {
    for (const revision of ['', 'a&root=other', '../x', 'a'.repeat(65)])
      expect(isFileRefusal(fileUrlFor('0', 'a.png', revision))).toBe(true);
    expect(fileUrlFor('0', 'a.png', 'session_2')).toBe(
      'cerebro-file://localhost/0/a.png?v=session_2',
    );
  });
  it('loads strictly and distinguishes typed refusal from transport failure', () => {
    expect(parseBytesRules(RAW)).toEqual(RAW);
    for (const bad of [
      null,
      [],
      { ...RAW, format: 2 },
      { ...RAW, extra: true },
      { ...RAW, limits: { ...RAW.limits, body_bytes: 0 } },
      { ...RAW, refusals: {} },
    ])
      expect(() => parseBytesRules(bad)).toThrow();
    expect(isFileRefusal({ code: 'outside', message: 'x' })).toBe(true);
    for (const bad of [null, 'outside', { code: 'outside' }, { code: 'new_code', message: 'x' }])
      expect(isFileRefusal(bad)).toBe(false);
  });
});
