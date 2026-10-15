import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import GRANT_SCOPE from '../../src-tauri/fixtures/grant-scope.json';
import { TOOLS } from '@/lib/policy/tools';
import { effectiveCeiling, plan, type ShellCeiling } from '@/lib/policy/toolApproval';
import { makeEntry } from '@/test/factories';
import {
  accessLines,
  GOVERNED_TYPES,
  KNOWLEDGE_LOG,
  OWN_NOTES_TOOL,
  pageAccess,
  scopeAdmits,
  summaryWords,
  writesInWords,
  type AccessRow,
} from './agentAccess';
import { parseReadScope, parseScope } from './agents';
import type { Entry } from './types';

const REPO = join(__dirname, '../..');

const RISK = 'records/risks/risk-rollback-unrehearsed.md';
const SCHEDULE = 'delivery/how-we-schedule.md';
const TYPE_DOC = 'types/risk.md';
const SCOUT_PATH = 'records/agents/release-scout.md';
const KNOWLEDGE_PATH = 'records/agents/knowledge.md';
const SOURCE = 'sources/issues/phx-421.md';

/** release-scout as demo-vault writes it. */
function scout(extra: Record<string, unknown> = {}): Entry {
  return makeEntry({
    path: SCOUT_PATH,
    type: 'Agent',
    title: 'Release scout',
    properties: {
      slug: 'release-scout',
      tools: 'safe',
      scope: ['records/risks'],
      ...extra,
    } as never,
  });
}

/** The knowledge agent as demo-vault writes it. */
const KNOWLEDGE = makeEntry({
  path: KNOWLEDGE_PATH,
  type: 'Agent',
  title: 'Knowledge agent',
  properties: {
    slug: 'knowledge',
    tools: 'safe',
    capabilities: ['knowledge'],
    scope: [],
    'allowed-tools': [
      'get_vault_context',
      'search_notes',
      'get_note',
      'knowledge_about',
      'list_inbox',
      'write_concept',
      'cache_source',
    ],
  },
});

const PAGES: Entry[] = [
  makeEntry({ path: RISK, type: 'Risk' }),
  makeEntry({ path: SCHEDULE }),
  makeEntry({ path: TYPE_DOC, type: 'Type' }),
  makeEntry({ path: 'knowledge/log.md' }),
  makeEntry({ path: 'knowledge/index.md' }),
  makeEntry({ path: SOURCE, type: 'Source', properties: { source_id: 'PHX-421' } }),
  makeEntry({ path: 'sources/issues/notes.md' }),
];

function vault(...agents: Entry[]): Entry[] {
  return [...PAGES, ...agents];
}

function access(
  entries: Entry[],
  path: string,
  shell: ShellCeiling = 'off',
  panelAgent: string | null = null,
) {
  const type = entries.find((e) => e.path === path)?.type ?? null;
  return pageAccess({ entries, path, type, shell, panelAgent });
}

function row(rows: AccessRow[], actor: string): AccessRow {
  const found = rows.find((r) => !r.panel && r.actor === actor);
  if (found === undefined) throw new Error(`no row for ${actor}`);
  return found;
}

const panelRow = (rows: AccessRow[]) => rows.find((r) => r.panel) as AccessRow;

const title = (name: string) => TOOLS.tools.find((t) => t.name === name)?.title as string;

describe('the shared scope cases', () => {
  it('replays the shared scope cases', () => {
    expect(GRANT_SCOPE.format).toBe(1);
    expect(GRANT_SCOPE.parse.length).toBeGreaterThan(0);
    for (const c of GRANT_SCOPE.parse) {
      const entry = makeEntry({
        path: 'records/agents/case.md',
        type: 'Agent',
        properties: c.properties as never,
        relationships: c.relationships as Record<string, string[]>,
      });
      const read = c.key === 'scope' ? parseScope(entry) : parseReadScope(entry);
      expect(read, c.name).toEqual(c.folders);
    }
    expect(GRANT_SCOPE.admits.length).toBeGreaterThan(0);
    for (const c of GRANT_SCOPE.admits) {
      expect(scopeAdmits(c.scope, c.path), c.name).toBe(c.admits);
    }
  });
});

describe('pageAccess', () => {
  it('names release-scout inside its scope, and why', () => {
    const page = access(vault(scout(), KNOWLEDGE), RISK);
    const r = row(page.rows, 'process:release-scout');
    expect(r.write).toBe('yes');
    expect(r.attended).toBe('yes');
    expect(r.unattended).toBe('yes');
    const lines = accessLines(r);
    expect(lines.status).toBe('Can change it');
    expect(lines.reasons[0]).toBe('Inside its write scope: records/risks/.');
    expect(lines.reasons).toContain('Runs when you ask, or when another agent hands it work.');
    expect(summaryWords(page)).toBe('1 of 2 agents can change this page.');
  });

  it('refuses release-scout outside its scope', () => {
    const page = access(vault(scout(), KNOWLEDGE), SCHEDULE);
    const r = row(page.rows, 'process:release-scout');
    expect(r.write).toBe('none');
    expect(accessLines(r).reasons[0]).toBe('Outside its write scope: records/risks/.');
    expect(summaryWords(page)).toBe('No agent can change this page.');
  });

  it('lets the knowledge agent only read', () => {
    const r = row(access(vault(scout(), KNOWLEDGE), RISK).rows, 'process:knowledge');
    expect(r.write).toBe('none');
    expect(r.read).toBe(true);
    const lines = accessLines(r);
    expect(lines.status).toBe('Can read it');
    expect(lines.reasons.slice(0, 2)).toEqual([
      'Its write scope is empty.',
      'None of its tools change a page.',
    ]);
    expect(lines.reasons.at(-1)).toBe('Reads it: no read scope.');
  });

  it('keeps every row off a Type doc and off another agent’s page, the panel included', () => {
    // Scoped as demo-vault writes it, and with no scope at all.
    const unscoped = makeEntry({ ...scout(), properties: { slug: 'release-scout' } });
    for (const list of [vault(scout(), KNOWLEDGE), vault(unscoped, KNOWLEDGE)]) {
      const typeDoc = access(list, TYPE_DOC);
      for (const r of typeDoc.rows) expect(r.write, r.title).toBe('none');
      expect(accessLines(row(typeDoc.rows, 'process:release-scout')).reasons).toContain(
        "Type docs are the vault's schema. Only people change them.",
      );
      const other = access(list, KNOWLEDGE_PATH);
      for (const r of other.rows) expect(r.write, r.title).toBe('none');
      expect(accessLines(row(other.rows, 'process:release-scout')).reasons).toContain(
        'Agent pages are grants. Only people change them.',
      );
    }
  });

  it('gives an agent only its own notes on its own page', () => {
    const own = row(access(vault(scout(), KNOWLEDGE), SCOUT_PATH).rows, 'process:release-scout');
    expect(own.write).toBe('own-notes');
    const lines = accessLines(own);
    expect(lines.status).toBe('Only its own notes');
    expect(lines.reasons).toContain(
      'On its own page it may rewrite its recent notes, and nothing else.',
    );
    // Without the notes writer, nothing.
    const narrowed = scout({ 'allowed-tools': ['get_note', 'append_to_note'] });
    expect(row(access(vault(narrowed), SCOUT_PATH).rows, 'process:release-scout').write).toBe(
      'none',
    );
    // Two records answering one handle: neither is this run's.
    const twin = makeEntry({
      path: 'records/agents/scout-two.md',
      type: 'Agent',
      title: 'Scout two',
      properties: { slug: 'release-scout' },
    });
    for (const r of access(vault(scout(), twin), SCOUT_PATH).rows) {
      expect(r.write, r.title).toBe('none');
    }
    // And the knowledge agent, which holds no notes writer, reads the rule.
    const k = row(access(vault(scout(), KNOWLEDGE), KNOWLEDGE_PATH).rows, 'process:knowledge');
    expect(k.write).toBe('none');
  });

  describe('the shell', () => {
    const shelled = (extra: Record<string, unknown> = {}) =>
      scout({ tools: 'shell', schedule: 'weekdays 08:30', ...extra });

    /** Each shown shell reason agrees with plan()'s decision for the run. */
    function agrees(r: AccessRow, ceiling: ShellCeiling) {
      const lines = accessLines(r).reasons;
      const withheld = r.shell.withheld;
      const planned = (readScoped: boolean, narrowing: ((t: string) => boolean) | null) =>
        plan({
          kind: 'attended',
          shell: effectiveCeiling(ceiling, r.axes.shell),
          askFirst: r.axes.askFirst,
          readScoped,
          narrowing,
        }).decisions.filter((d) => ['Write', 'Edit', 'Bash'].includes(d.tool));
      const writes = (ds: { decision: string }[]) =>
        ds.some((d) => d.decision === 'allow' || d.decision === 'ask');
      if (withheld === 'ceiling') {
        expect(lines).toContain('Shell is Off in Settings.');
        expect(writes(planned(false, null))).toBe(false);
      }
      if (withheld === 'read-limit') {
        expect(lines).toContain('A read limit withdraws its shell.');
        expect(writes(planned(true, null))).toBe(false);
        expect(writes(planned(false, null))).toBe(true);
      }
      if (withheld === 'narrowing') {
        expect(lines).toContain('Its allowed tools leave out the shell.');
        expect(writes(planned(false, null))).toBe(true);
      }
      if (lines.some((l) => l.startsWith('Shell is On'))) expect(r.shell.attended).toBe('yes');
      if (lines.some((l) => l.startsWith('Shell is Ask'))) expect(r.shell.attended).toBe('asks');
    }

    it('reaches a Type doc on duty when Settings has it On', () => {
      const r = row(access(vault(shelled()), TYPE_DOC, 'on').rows, 'process:release-scout');
      expect(r.attended).toBe('yes');
      expect(r.unattended).toBe('yes');
      expect(accessLines(r).status).toBe('Can change it with the shell');
      expect(accessLines(r).reasons).toContain(
        'Shell is On: it can change any file in the vault folder, past every rule above.',
      );
      expect(accessLines(r).reasons).toContain('Runs on its own: weekdays 08:30.');
      agrees(r, 'on');
    });

    it('widens only attended reach under Ask', () => {
      const r = row(access(vault(shelled()), TYPE_DOC, 'ask').rows, 'process:release-scout');
      expect(r.attended).toBe('asks');
      expect(r.unattended).toBe('none');
      expect(accessLines(r).status).toBe('Can change it once you allow it');
      expect(accessLines(r).reasons).toContain('Unattended runs go without the shell.');
      agrees(r, 'ask');
    });

    it('adds no unattended shell off duty', () => {
      const offDuty = scout({ tools: 'shell' });
      const r = row(access(vault(offDuty), TYPE_DOC, 'on').rows, 'process:release-scout');
      expect(r.attended).toBe('yes');
      expect(r.unattended).toBe('none');
      expect(accessLines(r).reasons).toContain('Unattended runs go without the shell.');
    });

    it('is withdrawn by Settings, a read limit and a narrowing, each said', () => {
      const off = row(access(vault(shelled()), TYPE_DOC, 'off').rows, 'process:release-scout');
      expect(off.shell.withheld).toBe('ceiling');
      agrees(off, 'off');
      const limited = row(
        access(vault(shelled({ 'read-scope': ['records'] })), TYPE_DOC, 'on').rows,
        'process:release-scout',
      );
      expect(limited.write).toBe('none');
      expect(limited.shell.withheld).toBe('read-limit');
      agrees(limited, 'on');
      const narrowed = row(
        access(vault(shelled({ 'allowed-tools': ['get_note'] })), TYPE_DOC, 'on').rows,
        'process:release-scout',
      );
      expect(narrowed.write).toBe('none');
      expect(narrowed.shell.withheld).toBe('narrowing');
      agrees(narrowed, 'on');
    });

    it('says nothing of a shell the record never declared', () => {
      const r = row(access(vault(scout()), TYPE_DOC, 'on').rows, 'process:release-scout');
      expect(r.shell.withheld).toBeNull();
      expect(accessLines(r).reasons.some((l) => l.includes('Shell') || l.includes('shell'))).toBe(
        false,
      );
    });
  });

  it('turns ask-first into asks while you watch and Review unattended, never on its own notes', () => {
    const asking = scout({ 'ask-first': true });
    const r = row(access(vault(asking), RISK).rows, 'process:release-scout');
    expect(r.tools.attended).toBe('asks');
    expect(r.tools.unattended).toBe('asks');
    expect(accessLines(r).status).toBe('Can change it once you allow it');
    expect(accessLines(r).reasons).toEqual(
      expect.arrayContaining([
        'It asks you before each page write.',
        'Unattended, its page writes wait in Review.',
      ]),
    );
    const own = row(access(vault(asking), SCOUT_PATH).rows, 'process:release-scout');
    expect(own.write).toBe('own-notes');
    expect(accessLines(own).reasons).not.toContain('It asks you before each page write.');
  });

  it('drops edit_note outside the read scope', () => {
    const r = row(
      access(vault(scout({ 'read-scope': ['delivery'] })), RISK).rows,
      'process:release-scout',
    );
    expect(r.write).toBe('yes');
    const reasons = accessLines(r).reasons;
    const changes = reasons.find((l) => l.startsWith('Changes pages with:')) as string;
    expect(changes).not.toContain(title('edit_note'));
    expect(changes).toContain(title('append_to_note'));
    expect(reasons).toContain(`${title('edit_note')} also needs the page inside its read scope.`);
    expect(reasons.at(-1)).toBe('Outside its read scope: delivery/.');
  });

  it('keeps knowledge/ out of reach of the note tools', () => {
    const open = makeEntry({ path: 'records/agents/open.md', type: 'Agent', title: 'Open' });
    const r = row(access(vault(open), 'knowledge/index.md').rows, 'process:open');
    expect(r.write).toBe('none');
    expect(accessLines(r).reasons).toContain(
      "Files under knowledge/ change only through Knowledge's own tools.",
    );
  });

  it('lets a concept writer append the knowledge log, whatever its scope', () => {
    const page = access(vault(scout(), KNOWLEDGE), KNOWLEDGE_LOG);
    const k = row(page.rows, 'process:knowledge');
    expect(k.write).toBe('yes');
    const lines = accessLines(k);
    expect(lines.status).toBe('Can change it');
    expect(lines.reasons).not.toContain('None of its tools change a page.');
    expect(lines.reasons).toContain(
      `Appends to the knowledge log with: ${title('write_concept')}, whatever its write scope.`,
    );
    expect(row(page.rows, 'process:release-scout').write).toBe('yes');
    expect(summaryWords(page)).toBe('2 of 2 agents can change this page.');
    // recheck_concept moves a stamp and logs nothing.
    const rechecker = scout({ 'allowed-tools': ['recheck_concept', 'cache_source'] });
    expect(row(access(vault(rechecker), KNOWLEDGE_LOG).rows, 'process:release-scout').write).toBe(
      'none',
    );
  });

  it('lets a source writer rewrite a cached source past its scope', () => {
    const page = access(vault(scout(), KNOWLEDGE), SOURCE);
    const k = row(page.rows, 'process:knowledge');
    expect(k.write).toBe('yes');
    expect(k.unattended).toBe('yes');
    const lines = accessLines(k);
    expect(lines.status).toBe('Can change it');
    expect(lines.reasons.slice(0, 2)).toEqual([
      'Its write scope is empty.',
      `Rewrites cached sources with: ${title('cache_source')}, whatever its write scope.`,
    ]);
    const s = row(page.rows, 'process:release-scout');
    expect(s.write).toBe('yes');
    expect(accessLines(s).reasons[0]).toBe('Outside its write scope: records/risks/.');
    expect(summaryWords(page)).toBe('2 of 2 agents can change this page.');
    // Ask-first does not hold it: cache_source is not confirmable.
    const careful = scout({ 'ask-first': true, 'allowed-tools': ['cache_source'] });
    expect(row(access(vault(careful), SOURCE).rows, 'process:release-scout').write).toBe('yes');
    // Without the tool, or on a page holding no source id, nothing.
    const reader = scout({ 'allowed-tools': ['get_note'] });
    expect(row(access(vault(reader), SOURCE).rows, 'process:release-scout').write).toBe('none');
    const loose = access(vault(scout(), KNOWLEDGE), 'sources/issues/notes.md');
    expect(row(loose.rows, 'process:knowledge').write).toBe('none');
    expect(summaryWords(loose)).toBe('No agent can change this page.');
  });

  it("reads the demo vault's cached PHX-421 as the knowledge agent's to rewrite", () => {
    const text = readFileSync(join(REPO, 'demo-vault', SOURCE), 'utf8');
    const sourceId = /^source_id: (.+)$/m.exec(text)?.[1] ?? '';
    expect(sourceId).toBe('PHX-421');
    const demo = makeEntry({ path: SOURCE, type: 'Source', properties: { source_id: sourceId } });
    const page = access([demo, scout(), KNOWLEDGE], SOURCE);
    expect(page.canChange).toBe(2);
    expect(accessLines(row(page.rows, 'process:knowledge')).status).toBe('Can change it');
  });

  it('reads a malformed scope as empty', () => {
    const cases: Partial<Entry>[] = [
      { properties: { scope: null } },
      { properties: { scope: 5 } },
      { properties: { scope: {} as never } },
      { properties: {}, relationships: { scope: ['Product'] } },
    ];
    for (const c of cases) {
      const agent = makeEntry({
        path: 'records/agents/odd.md',
        type: 'Agent',
        title: 'Odd',
        properties: { ...(c.properties ?? {}) },
        relationships: c.relationships ?? {},
      });
      const r = row(access(vault(agent), RISK).rows, 'process:odd');
      expect(r.write).toBe('none');
      expect(accessLines(r).reasons[0]).toBe('Its write scope is empty.');
    }
  });

  it('lists the panel first: unbound it reaches every page that is not governed', () => {
    const page = access(vault(scout(), KNOWLEDGE), SCHEDULE);
    expect(page.rows[0].panel).toBe(true);
    const p = panelRow(page.rows);
    expect(p.actor).toBe('claude-code');
    expect(p.write).toBe('yes');
    expect(p.unattended).toBe('none');
    expect(accessLines(p).reasons).toContain('Runs when you ask.');
    expect(accessLines(p).reasons[0]).toBe("No write scope, so Cerebro's tools reach every page.");
    // The panel is not an agent: the summary counts agents.
    expect(page.canChange).toBe(0);
  });

  it('gives a bound panel its record’s axes, and reads a dangling binding as unbound', () => {
    const bound = panelRow(access(vault(scout()), SCHEDULE, 'off', 'release-scout').rows);
    expect(bound.write).toBe('none');
    expect(bound.boundTo).toBe('Release scout');
    expect(accessLines(bound).reasons).toContain('Answers as Release scout here.');
    expect(panelRow(access(vault(scout()), RISK, 'off', 'release-scout').rows).write).toBe('yes');
    const dangling = panelRow(access(vault(scout()), SCHEDULE, 'off', 'nobody').rows);
    expect(dangling.write).toBe('yes');
    expect(dangling.boundTo).toBeNull();
  });

  it('summarises measured reach, never a blank list', () => {
    expect(summaryWords(access(PAGES, RISK))).toBe('No agents in this vault yet.');
    expect(summaryWords(access(vault(KNOWLEDGE), RISK))).toBe('No agent can change this page.');
    expect(summaryWords(access(vault(scout(), KNOWLEDGE), RISK))).toBe(
      '1 of 2 agents can change this page.',
    );
  });

  it('names the page writers by their manifest titles', () => {
    const reasons = accessLines(
      row(access(vault(scout()), RISK).rows, 'process:release-scout'),
    ).reasons;
    const writers = TOOLS.tools
      .filter((t) => t.door === 'note' && t.target?.kind === 'note')
      .map((t) => t.title);
    expect(writers.length).toBeGreaterThan(0);
    expect(reasons[1]).toBe(`Changes pages with: ${writers.join(', ')}.`);
  });
});

describe('the twins Rust holds', () => {
  const MCP = readFileSync(join(REPO, 'src-tauri/src/mcp.rs'), 'utf8');

  function body(name: string): string {
    const start = MCP.indexOf(`fn ${name}(`);
    expect(start, name).toBeGreaterThan(-1);
    return MCP.slice(start, MCP.indexOf('\n}\n', start));
  }

  it("the governed list is Rust's", () => {
    const arms = [...body('governed_type_refusal').matchAll(/Some\("([^"]+)"\) =>/g)].map(
      (m) => m[1],
    );
    expect([...arms].sort()).toEqual([...GOVERNED_TYPES].sort());
  });

  it("the knowledge log is Rust's", () => {
    const knowledge = readFileSync(join(REPO, 'src-tauri/src/knowledge.rs'), 'utf8');
    expect(knowledge).toContain(`pub const LOG_PATH: &str = "${KNOWLEDGE_LOG}";`);
  });

  it("the scope exemption is Rust's", () => {
    // Both Knowledge doors pass the write scope on purpose; if Rust starts
    // scoping either, the door writers here overclaim.
    expect(body('grant_admission')).toContain('`write_concept` and `cache_source` are');
  });

  it("the own-notes crossing is Rust's", () => {
    expect(body('own_memory_record')).toContain(`if name != "${OWN_NOTES_TOOL}"`);
    expect(TOOLS.tools.some((t) => t.name === OWN_NOTES_TOOL)).toBe(true);
  });
});

describe('writesInWords', () => {
  const grant = (
    scope: string[] | null,
    allowedTools: string[] | null = null,
    shell: boolean | null = false,
  ) => ({ scope, readScope: null, allowedTools, shell });
  /** Note writers and no Knowledge door. */
  const NOTES = ['get_note', 'append_to_note', 'edit_note'];

  it('says where its tools write', () => {
    expect(writesInWords(grant(['records/risks', 'delivery'], NOTES), 'off')).toBe(
      'records/risks/, delivery/',
    );
    expect(writesInWords(grant(null, NOTES), 'off')).toBe('any page but Type docs and Agent pages');
    expect(writesInWords(grant([], ['append_to_note']), 'off')).toBe('no page');
  });

  it('says when none of its tools change a page, and Knowledge’s own doors', () => {
    expect(writesInWords(grant(null, ['get_note', 'search_notes']), 'off')).toBe(
      'no page — none of its tools change one',
    );
    expect(writesInWords(grant([], ['get_note', 'write_concept', 'cache_source']), 'off')).toBe(
      'Knowledge and sources only, through their own tools',
    );
    expect(writesInWords(grant([]), 'off')).toBe(
      'Knowledge and sources only, through their own tools',
    );
  });

  it('keeps Knowledge’s own doors beside the pages it writes', () => {
    expect(writesInWords(grant(['records/risks']), 'off')).toBe(
      'records/risks/; Knowledge and sources through their own tools',
    );
    expect(writesInWords(grant(null, ['append_to_note', 'cache_source']), 'off')).toBe(
      'any page but Type docs and Agent pages; Knowledge and sources through their own tools',
    );
  });

  it('adds the shell where it widens reach', () => {
    expect(writesInWords(grant(['records/risks'], null, true), 'on')).toBe(
      'records/risks/; Knowledge and sources through their own tools · any file with the shell',
    );
    expect(writesInWords(grant(['records/risks'], null, true), 'ask')).toBe(
      'records/risks/; Knowledge and sources through their own tools · any file with the shell, once you allow it',
    );
    const scoped = 'records/risks/; Knowledge and sources through their own tools';
    expect(writesInWords(grant(['records/risks'], null, true), 'off')).toBe(scoped);
    expect(writesInWords(grant(['records/risks'], null, false), 'on')).toBe(scoped);
  });
});
