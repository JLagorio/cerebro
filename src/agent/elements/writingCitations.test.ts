import { describe, expect, it } from 'vitest';
import { citedSource, noSourceText } from './writingCitations';

/**
 * A listed source as its citation card's entry (M91.14): a URL stays a URL
 * (the element links only http(s), CV-16), a path is a vault path, and the
 * page's definition is said only when it says more than the name.
 */

describe('citedSource', () => {
  it('reads a URL as an address out of the vault, whatever its scheme', () => {
    expect(
      citedSource({ resource: ' https://example.com/second ', name: 'The second source' }),
    ).toEqual({
      kind: 'url',
      url: 'https://example.com/second',
      title: 'The second source',
      via: 'text',
    });
    expect(citedSource({ resource: 'mailto:ops@example.com', name: 'Ops' })).toMatchObject({
      kind: 'url',
      url: 'mailto:ops@example.com',
    });
  });

  it('reads anything else as a vault path, without its leading slash', () => {
    expect(citedSource({ resource: '/records/first.md', name: 'First record' })).toEqual({
      kind: 'vault',
      path: 'records/first.md',
      title: 'First record',
      via: 'text',
    });
    expect(citedSource({ resource: 'all telemetry in eu-west', name: 'Telemetry' })).toMatchObject({
      kind: 'vault',
      path: 'all telemetry in eu-west',
    });
  });

  it('says the page’s definition only when it adds to the name', () => {
    expect(
      citedSource({
        resource: '/records/first.md',
        name: 'The first source',
        definition: ' First, as the page puts it ',
      }).description,
    ).toBe('First, as the page puts it');
    expect(
      citedSource({
        resource: '/a.md',
        name: 'As the page puts it',
        definition: 'As the page puts it',
      }).description,
    ).toBeUndefined();
    expect(citedSource({ resource: '/a.md', name: '' }).title).toBeUndefined();
  });
});

it('names a citation nothing backs in words', () => {
  expect(noSourceText('loose')).toBe('No source "loose"');
});
