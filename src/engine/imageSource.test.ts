import { describe, expect, it } from 'vitest';
import { imageSource } from './imageSource';
describe('image source boundary', () => {
  it.each([
    ['https://images.example/a.png', 'remote'],
    [' HTTPS://images.example/a.png ', 'remote'],
    ['http://images.example/a.png', 'insecure'],
    ['//images.example/a.png', 'insecure'],
    ['data:image/png;base64,AQI=', 'data'],
    ['attachments/a b.png', 'vault'],
    ['../a.png', 'vault'],
    ['javascript:alert(1)', 'refused'],
    ['file:///a.png', 'refused'],
    ['ftp://host/a.png', 'refused'],
    ['https:host/a.png', 'refused'],
    ['ht\ntps://host/a.png', 'refused'],
    ['\\\\host/a.png', 'refused'],
    ['', 'refused'],
  ])('classifies %s as %s', (source, expected) => expect(imageSource(source)).toBe(expected));
});
