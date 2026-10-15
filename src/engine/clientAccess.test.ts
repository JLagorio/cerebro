import { describe, expect, it } from 'vitest';
import CASES from '../../src-tauri/fixtures/client-tokens.json';
import {
  clientGrant,
  clientName,
  clientReach,
  clientSnippets,
  grantWords,
  type ClientToken,
} from './clientAccess';
const secret = `cbr_${'a'.repeat(64)}`;
const url = 'http://127.0.0.1:37421/mcp';
const token = (patch: Partial<ClientToken> = {}): ClientToken => ({
  name: 'Editor',
  slug: 'editor',
  tokenId: '1',
  vaultId: 'demo',
  vaultPath: '/demo-vault',
  currentVault: true,
  createdAt: '2026-10-15T00:00:00Z',
  lastUsedAt: null,
  toolsets: ['read', 'write'],
  writeScope: ['notes'],
  readScope: null,
  ...patch,
});
describe('client access', () => {
  for (const row of CASES.names)
    it(`shared name ${JSON.stringify(row.name)}`, () => {
      if ('refusal' in row.expect) expect(() => clientName(row.name)).toThrow(row.expect.refusal);
      else expect(clientName(row.name)).toEqual(row.expect);
    });
  for (const row of CASES.grants)
    it(`shared grant ${row.name}`, () => {
      if ('refusal' in row.expect)
        expect(() => clientGrant(row.request)).toThrow(row.expect.refusal);
      else expect(clientGrant(row.request)).toEqual(row.expect.grant);
    });
  it('slug folding changes ASCII letters only', () =>
    expect(clientName('İ東京')).toEqual({ name: 'İ東京', slug: 'app' }));
  it('describes read, write and non-writing toolsets from the manifest', () => {
    expect(grantWords(token())).toEqual(['Reads the whole vault', 'Writes notes']);
    expect(
      grantWords(
        token({ toolsets: ['read', 'comment'], readScope: ['notes', 'projects'], writeScope: [] }),
      ),
    ).toEqual(['Reads notes, projects', 'Comment on pages']);
  });
  it('names a distinct server and puts the secret exactly once in each snippet', () => {
    const snippets = clientSnippets({ url, secret });
    for (const snippet of Object.values(snippets)) {
      expect(snippet.split(secret)).toHaveLength(2);
      expect(snippet).toContain('cerebro-vault');
    }
    expect(snippets.claude).toBe(
      `claude mcp add --transport http cerebro-vault ${url} --header "Authorization: Bearer ${secret}"`,
    );
    expect(Object.keys(JSON.parse(snippets.cursor).mcpServers)).toEqual(['cerebro-vault']);
  });
  it('interpolates only local addresses and well-formed secrets, independently', () => {
    for (const url of [
      null,
      'https://elsewhere/mcp',
      'http://127.0.0.1:3/mcp;echo nope',
      '$(echo nope)',
    ]) {
      const snippets = clientSnippets({ url, secret });
      expect(snippets.claude).toContain('<address>');
      expect(snippets.claude).not.toContain('nope');
    }
    for (const invalid of [null, '$(echo nope)', 'cbr_short', `cbr_${'A'.repeat(64)}`]) {
      const snippets = clientSnippets({ url, secret: invalid });
      expect(snippets.claude).toContain('<your token>');
      expect(snippets.claude).toContain(url);
    }
  });
  it('reads folder boundaries, writing capability, protected pages and current vault', () => {
    expect(clientReach([token()], 'notes/one.md', false)[0]).toMatchObject({
      read: true,
      write: true,
      reason: "Inside its token's write scope: notes.",
    });
    expect(
      clientReach([token({ readScope: ['notes'] })], 'notes-more/a.md', false)[0],
    ).toMatchObject({
      read: false,
      write: false,
      reason: "Outside its token's write scope: notes.",
    });
    expect(clientReach([token()], 'notes/agent.md', true)[0].write).toBe(false);
    expect(
      clientReach([token({ writeScope: ['knowledge'] })], 'knowledge/a.md', false)[0].write,
    ).toBe(false);
    expect(
      clientReach([token({ toolsets: ['read', 'comment'] })], 'notes/a.md', false)[0],
    ).toMatchObject({ write: false, reason: 'Its token only reads.' });
    expect(clientReach([token({ currentVault: false })], 'notes/a.md', false)).toEqual([]);
  });
});
