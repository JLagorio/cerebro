import { describe, expect, it } from 'vitest';
import { sha256Hex, sha256Bytes } from './sha256';
import { createHash } from 'node:crypto';

describe('sha256Hex', () => {
  it('hashes arbitrary attachment bytes without text decoding', () => {
    const bytes = Uint8Array.from([0, 255, 128, 192, 254, 1, 10]);
    expect(sha256Bytes(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
  });
  it('matches the FIPS 180-4 test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    // 56 bytes — padding pushes this into a second block, so the
    // multi-block path is exercised (real fingerprints routinely exceed
    // one block).
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    expect(sha256Hex('a'.repeat(1_000_000))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });

  it('matches the same FIPS vectors through raw document bytes', () => {
    for (const [input, hash] of [
      ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
      ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
      [
        'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
        '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
      ],
      ['a'.repeat(1_000_000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
    ])
      expect(sha256Bytes(new TextEncoder().encode(input))).toBe(hash);
  });

  it('hashes multi-byte UTF-8 by its byte encoding', () => {
    // "é" is 0xC3 0xA9 — the digest must cover bytes, not code units, or
    // the TS and Rust sides would disagree on any non-ASCII env value.
    expect(sha256Hex('é')).toBe(sha256Hex('é'));
    expect(sha256Hex('é')).not.toBe(sha256Hex('e'));
  });
});
