import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildHelpCatalog, compileHelp, MAX_HELP_BYTES } from './build-help';

const input = () => ({
  version: '0.1.0',
  topics: [
    { id: 'knowledge', title: 'Review knowledge', file: 'knowledge.md', tools: ['write_concept'] },
  ],
  readSource: () => '# Review\n\nRead evidence before verifying.\n',
  toolNames: ['write_concept'],
  retiredTerms: ['retired vocabulary'],
});

describe('shipped product help', () => {
  it('binds exact human source bytes to the app version and content hash', () => {
    const args = input();
    const topic = compileHelp(args).topics[0];
    expect(topic).toEqual({
      id: 'knowledge',
      title: 'Review knowledge',
      appVersion: '0.1.0',
      body: args.readSource(),
      contentHash: createHash('sha256').update(args.readSource()).digest('hex'),
    });
  });
  it.each([
    ['missing version', { version: '' }],
    ['unknown tool', { toolNames: [] }],
    ['undeclared inline tool', { readSource: () => 'Use tool:invented_tool.' }],
    ['retired vocabulary', { readSource: () => 'Retired Vocabulary' }],
    ['private file path', { topics: [{ ...input().topics[0], file: '../private.md' }] }],
    ['duplicate IDs', { topics: [...input().topics, ...input().topics] }],
    ['over-limit UTF-8 retrieval', { readSource: () => '界'.repeat(MAX_HELP_BYTES / 2) }],
  ])('rejects %s', (_reason, change) => {
    expect(() => compileHelp({ ...input(), ...change })).toThrow();
  });
  it('ships exactly the generated five-topic catalog, without hand-edited provenance', () => {
    const actual = JSON.parse(readFileSync('shared/help/generated.v1.json', 'utf8'));
    expect(actual).toEqual(buildHelpCatalog(process.cwd()));
    expect(actual.topics.map((topic: { id: string }) => topic.id)).toEqual([
      'knowledge',
      'reviewed-work',
      'imports',
      'schedules',
      'recovery',
    ]);
    for (const topic of actual.topics)
      expect(Buffer.byteLength(JSON.stringify(topic))).toBeLessThanOrEqual(MAX_HELP_BYTES);
  });
});
