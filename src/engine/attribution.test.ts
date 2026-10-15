import { describe, expect, it } from 'vitest';
import RECEIPT_RS from '../../src-tauri/src/vault/receipt.rs?raw';
import {
  attributionLine,
  HUMAN_ACTOR,
  pagesWritten,
  pageWriteWords,
  writerWords,
  type LastWrite,
  type PageWrite,
} from './attribution';
import { CONSTRUCT_ACTORS } from './authors';
import { makeEntry } from './testHelpers';

const scout = makeEntry({
  path: 'records/agents/release-scout.md',
  title: 'Release scout',
  type: 'Agent',
  properties: { description: 'Watches releases.', tools: 'safe' },
});
const entries = [scout];
const NOW = new Date('2026-07-28T12:00:00Z');

const last = (fields: Partial<LastWrite> = {}): LastWrite => ({
  kind: 'vault.write',
  actor: HUMAN_ACTOR,
  run_id: null,
  approved_by: null,
  at: '2026-07-28T10:00:00.000Z',
  ...fields,
});

const write = (fields: Partial<PageWrite> = {}): PageWrite => ({
  kind: 'vault.write',
  path: 'records/risks/a.md',
  to: null,
  at: '2026-07-28T10:00:00.000Z',
  approved_by: null,
  ...fields,
});

describe('writerWords (M58.1b)', () => {
  it("is Rust's human stamp", () => {
    expect(RECEIPT_RS).toContain(`pub const HUMAN_ACTOR: &str = "${HUMAN_ACTOR}";`);
  });

  it('reads your own writes as You', () => {
    expect(writerWords('human:me', entries)).toBe('You');
  });

  it("reads an agent's stamp as its page's title", () => {
    expect(writerWords('process:release-scout', entries)).toBe('Release scout');
  });

  it('reads the attended assistant as Assistant', () => {
    expect(writerWords('claude-code', entries)).toBe('Assistant');
  });

  it('reads a construct in its own words', () => {
    expect(writerWords(CONSTRUCT_ACTORS[0].actor, entries)).toBe('Background ingest');
  });

  it("reads a NULL actor as not recorded, never actorLabel's unattributed", () => {
    expect(writerWords(null, entries)).toBe('not recorded');
  });
});

describe('attributionLine (M58.1b)', () => {
  it('says who last changed the page, and when', () => {
    expect(attributionLine({ state: 'recorded', ...last() }, entries, NOW)).toBe(
      'Last changed by You · 2 hours ago',
    );
    expect(
      attributionLine(
        { state: 'recorded', ...last({ actor: 'process:release-scout', run_id: 'run-1' }) },
        entries,
        NOW,
      ),
    ).toBe('Last changed by Release scout · 2 hours ago');
  });

  it('adds that you allowed a write you approved', () => {
    expect(
      attributionLine(
        {
          state: 'recorded',
          ...last({ actor: 'process:release-scout', run_id: 'run-1', approved_by: HUMAN_ACTOR }),
        },
        entries,
        NOW,
      ),
    ).toBe('Last changed by Release scout · 2 hours ago · you allowed it');
  });

  it('says a NULL writer was not recorded', () => {
    expect(attributionLine({ state: 'recorded', ...last({ actor: null }) }, entries, NOW)).toBe(
      'Last changed by not recorded · 2 hours ago',
    );
  });

  it('says an outside change is unattributed, and who wrote before it', () => {
    expect(
      attributionLine({ state: 'unattributed', ...last({ actor: 'claude-code' }) }, entries, NOW),
    ).toBe('Changed outside Cerebro since Assistant wrote it 2 hours ago — unattributed');
  });

  it('says when nothing was recorded, and when Knowledge changed it', () => {
    expect(attributionLine({ state: 'not_recorded' }, entries, NOW)).toBe(
      'Who changed this page was not recorded',
    );
    expect(attributionLine({ state: 'knowledge' }, entries, NOW)).toBe('Changed through Knowledge');
  });
});

describe('pagesWritten (M58.1b)', () => {
  it('lists each page once, at its last write and where it moved, without comments or Knowledge', () => {
    const rows = [
      write({ kind: 'vault.create', path: 'records/risks/a.md' }),
      write({ kind: 'vault.comment', path: 'records/risks/.a.comments.json' }),
      write({ path: 'knowledge/systems/x.md' }),
      write({ path: 'records/risks/b.md' }),
      write({ path: 'records/risks/a.md' }),
      write({ kind: 'vault.rename', path: 'records/risks/b.md', to: 'records/risks/c.md' }),
    ];
    expect(pagesWritten(rows).map((w) => [w.to ?? w.path, pageWriteWords(w)])).toEqual([
      ['records/risks/a.md', 'changed'],
      ['records/risks/c.md', 'moved from records/risks/b.md'],
    ]);
  });

  it('words a create and a delete', () => {
    expect(pageWriteWords(write({ kind: 'vault.create' }))).toBe('created');
    expect(pageWriteWords(write({ kind: 'vault.delete' }))).toBe('removed');
  });
});
