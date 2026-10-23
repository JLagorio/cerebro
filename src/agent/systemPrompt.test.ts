import { describe, expect, it } from 'vitest';
import RETIRED from '../../shared/prompt/retired-terms.json';
import {
  attachmentFragments,
  attachmentReader,
  buildSystemPrompt,
  SYSTEM_FRAGMENTS,
} from './systemPrompt';
import { grantedTools, mentionedTools, type PromptGrant } from '@/engine/toolGrant';
import { PRODUCT_BRIEF } from '@/lib/productBrief';

/** A panel turn that holds every tool, the web among them (M57.7). */
const FULL: PromptGrant = { tools: grantedTools(null), shell: true, web: true, attended: true };

/** A grant holding exactly `tools`. */
const holding = (tools: string[], extra: Partial<PromptGrant> = {}): PromptGrant => ({
  tools: new Set(tools),
  shell: false,
  attended: true,
  ...extra,
});

/** The M9.5 sentence, pinned byte for byte: it changes only with the owner's sign-off. */
const ORGANIZE =
  'To file an Inbox capture, use propose_organize so the user can accept or reject it. Do not edit captures directly.';

/** M53's tools line, which a full attended grant still reads. */
const TOOLS_LINE =
  'Use the cerebro MCP tools: get_vault_context to orient, search_notes and get_note to read, and the write tools to change things. Call open_note so the user sees what you are referring to.';

/** M54.8's first line. The product brief follows it, in place of M53's
 * identity and vault-model lines, which taught the retired model. */
const IDENTITY = 'You are the assistant inside cerebro.';
const WIKILINKS = 'When you mention a note, write it as [[note-name]] so it is clickable.';
const SCHEMA =
  "Never create or modify `type: Type` docs on your own — schema is the user's to change. When a vault clearly needs a new type or field, describe the change and why, and let them make it (a database's own page and the adoption wizard are the human path).";

/** M57.7's web line, said to a run that holds WebFetch and cache_source. */
const WEB_LINE =
  'Pages you fetch with WebFetch or find with WebSearch must be written down with cache_source (kind web, the URL as its id), which keeps them under sources/. Search for a copy before fetching: one fetch, a local file, and later questions read the file.';

const lines = (prompt: string) => prompt.split('\n');

/**
 * M34.1.3 — the OKF contract is a capability, not the weather. An agent that
 * never declared `knowledge` must not be told it maintains the bundle,
 * because an agent told to write concepts will write concepts.
 */
describe('buildSystemPrompt capabilities', () => {
  it('emits the knowledge fragment only when the capability is declared', () => {
    const declared = buildSystemPrompt(
      { kind: 'none' },
      { capabilities: ['knowledge'], grant: FULL },
    );
    const undeclared = buildSystemPrompt({ kind: 'none' }, { grant: FULL });
    expect(declared).toContain('knowledge/ bundle');
    expect(declared).toContain('Never write `verified`');
    expect(undeclared).not.toContain('knowledge/ bundle');
    expect(undeclared).not.toContain('supersededBy');
  });

  // M52.3 — the snapshot carries learned-from concepts beside anchored ones,
  // and `relation` is the only thing telling the two apart.
  it('says how to read a knowledge note’s relation', () => {
    const declared = buildSystemPrompt(
      { kind: 'none' },
      { capabilities: ['knowledge'], grant: FULL },
    );
    expect(declared).toContain('`relation`');
    expect(declared).toContain('`learned from`');
    expect(declared).not.toContain('reached by `about:` anchor');
  });

  it('keeps everything that is not the knowledge fragment for everyone', () => {
    const undeclared = buildSystemPrompt({ kind: 'none' }, { grant: FULL });
    expect(undeclared).toContain('assistant inside cerebro');
    expect(undeclared).toContain('propose_organize');
    expect(undeclared).toContain('Be concise.');
  });

  it('still names where the user is standing, capability or not', () => {
    const prompt = buildSystemPrompt({ kind: 'inbox' }, { grant: FULL });
    expect(prompt).toContain('the Inbox');
  });
});

/**
 * M54.7 — every line declares the tools it names, and is said only to a run
 * that holds them. src/agent/promptGrant.test.ts tries every grant; these pin
 * the text.
 */
describe('buildSystemPrompt names only the tools the run holds', () => {
  it('declares exactly the tools each fixed line names, and a prohibition names none', () => {
    expect(SYSTEM_FRAGMENTS.length).toBeGreaterThan(0);
    for (const fragment of SYSTEM_FRAGMENTS) {
      expect(mentionedTools(fragment.text), fragment.id).toEqual([...fragment.uses].sort());
      if (fragment.kind === 'prohibition') expect(fragment.uses, fragment.id).toEqual([]);
    }
    expect(new Set(SYSTEM_FRAGMENTS.map((f) => f.id)).size).toBe(SYSTEM_FRAGMENTS.length);
  });

  // M53's prompt, less the two rules the server now holds (M54.7), with the
  // identity line and the product brief in place of its first two lines
  // (M54.8), and the web line last, since a full grant holds WebFetch
  // (M57.7). Nothing else moved.
  it('reads as M53 did, opened by the brief, less the two server rules and closed by the web line, under a full attended grant', () => {
    expect(buildSystemPrompt({ kind: 'none' }, { grant: FULL })).toBe(
      [IDENTITY, PRODUCT_BRIEF, TOOLS_LINE, ORGANIZE, 'Be concise.', WEB_LINE].join('\n'),
    );
    expect(buildSystemPrompt({ kind: 'none' }, { grant: { ...FULL, web: false } })).toBe(
      [IDENTITY, PRODUCT_BRIEF, TOOLS_LINE, ORGANIZE, 'Be concise.'].join('\n'),
    );
  });

  it('says every server rule on the fallback branch, after the tools line', () => {
    // The branch SERVER_RULES_IN_PROMPT turns on if a resumed turn stops
    // hearing the MCP instructions (the owner's live check).
    expect(buildSystemPrompt({ kind: 'none' }, { grant: FULL }, true)).toBe(
      [
        IDENTITY,
        PRODUCT_BRIEF,
        TOOLS_LINE,
        WIKILINKS,
        SCHEMA,
        'Mail you read through a connector stays out of notes: never copy a message, its text or its addresses into a page unless the person asks you to in this conversation.',
        'Never send email for the user. When they ask for one, leave it as a draft in their mail for them to read and send, and tell them where it is.',
        ORGANIZE,
        'Be concise.',
        WEB_LINE,
      ].join('\n'),
    );
  });

  it('says the web line only to a run that holds WebFetch and cache_source (M57.7)', () => {
    const said = (grant: PromptGrant) =>
      lines(buildSystemPrompt({ kind: 'none' }, { grant })).includes(WEB_LINE);
    expect(said(holding(['cache_source'], { web: true }))).toBe(true);
    expect(said(holding(['cache_source'], { web: true, attended: false }))).toBe(true);
    expect(said(holding(['cache_source'], { web: false }))).toBe(false);
    expect(said(holding(['cache_source']))).toBe(false);
    expect(said(holding(['get_note'], { web: true }))).toBe(false);
    // And no prompt names the web tools to a run without them.
    for (const connectors of [true, false]) {
      const prompt = buildSystemPrompt(
        { kind: 'inbox' },
        { grant: { ...FULL, web: false }, connectors, capabilities: ['knowledge'] },
      );
      expect(prompt).not.toMatch(/WebFetch|WebSearch/);
    }
  });

  it('keeps the M9.5 sentence byte for byte, for exactly the runs that hold propose_organize', () => {
    expect(SYSTEM_FRAGMENTS.find((f) => f.id === 'organize')?.text).toBe(ORGANIZE);
    const without = [...FULL.tools].filter((name) => name !== 'propose_organize');
    for (const attended of [true, false]) {
      for (const shell of [true, false]) {
        const held = buildSystemPrompt(
          { kind: 'none' },
          { grant: holding([...FULL.tools], { attended, shell }) },
        );
        const lacked = buildSystemPrompt(
          { kind: 'none' },
          { grant: holding(without, { attended, shell }) },
        );
        expect(lines(held)).toContain(ORGANIZE);
        expect(lacked).not.toContain('propose_organize');
      }
    }
  });

  it('never tells an unattended run to call open_note', () => {
    for (const tools of [[...FULL.tools], ['open_note'], ['open_note', 'get_note']]) {
      const prompt = buildSystemPrompt(
        { kind: 'inbox' },
        { grant: holding(tools, { attended: false, shell: true }), connectors: true },
      );
      expect(mentionedTools(prompt)).not.toContain('open_note');
    }
    expect(buildSystemPrompt({ kind: 'none' }, { grant: holding(['open_note']) })).toContain(
      'Call open_note so the user sees what you are referring to.',
    );
  });

  it('keeps only "Do not edit captures directly." for a run that lacks propose_organize and can edit one', () => {
    const said = (grant: PromptGrant) =>
      lines(buildSystemPrompt({ kind: 'none' }, { grant })).includes(
        'Do not edit captures directly.',
      );
    expect(said(holding(['update_frontmatter']))).toBe(true);
    expect(said(holding(['append_to_note']))).toBe(true);
    expect(said(holding([], { shell: true }))).toBe(true);
    // Nothing that edits a note on disk: nothing to forbid.
    expect(said(holding([]))).toBe(false);
    expect(said(holding(['create_note', 'write_concept', 'get_note']))).toBe(false);
    // And a run that holds propose_organize hears the whole M9.5 sentence instead.
    expect(said(holding(['propose_organize', 'update_frontmatter']))).toBe(false);
  });

  it('lists only the tools a narrowed run holds in its tools line', () => {
    const toolsLine = (tools: string[], attended = true) =>
      lines(buildSystemPrompt({ kind: 'none' }, { grant: holding(tools, { attended }) })).find(
        (line) => line.startsWith('Use the cerebro MCP tools') || line.startsWith('Call open_note'),
      );
    expect(toolsLine(['get_note'])).toBe('Use the cerebro MCP tools: get_note to read.');
    expect(toolsLine(['search_notes', 'get_note'])).toBe(
      'Use the cerebro MCP tools: search_notes and get_note to read.',
    );
    expect(toolsLine(['get_vault_context', 'search_notes'])).toBe(
      'Use the cerebro MCP tools: get_vault_context to orient and search_notes to read.',
    );
    expect(toolsLine(['create_note'])).toBe(
      'Use the cerebro MCP tools: the write tools to change things.',
    );
    expect(toolsLine(['open_note'])).toBe(
      'Call open_note so the user sees what you are referring to.',
    );
    expect(toolsLine(['open_note'], false)).toBeUndefined();
    expect(toolsLine([])).toBeUndefined();
    // open_note moves the screen and writes nothing, so it adds no write clause.
    expect(toolsLine(['get_vault_context', 'open_note'])).toBe(
      'Use the cerebro MCP tools: get_vault_context to orient. Call open_note so the user sees what you are referring to.',
    );
  });

  it('names the Notion importer only with its grant and connectors enabled', () => {
    for (const connectors of [true, false]) {
      for (const held of [true, false]) {
        const text = buildSystemPrompt(
          { kind: 'none' },
          { connectors, grant: holding(held ? ['import_notion_page'] : ['get_note']) },
        );
        expect(text.includes('import_notion_page')).toBe(connectors && held);
      }
    }
  });

  it('tells a run to cache what it fetches only when it holds cache_source', () => {
    const options = { connectors: true, issuePrefixes: 'KES, OPS' };
    const held = buildSystemPrompt({ kind: 'none' }, { ...options, grant: FULL });
    expect(held).toContain('must be written down with cache_source');
    const lacked = buildSystemPrompt(
      { kind: 'none' },
      { ...options, grant: holding(['get_note']) },
    );
    expect(lacked).not.toContain('cache_source');
    // The issue keys name no tool, so they keep their M8.2 rule: the switch alone.
    expect(lacked).toContain("This vault's issue-tracker project keys are KES, OPS.");
    // The connector line goes with the switch; the web line is the grant's.
    const off = buildSystemPrompt(
      { kind: 'none' },
      { issuePrefixes: 'KES', grant: { ...FULL, web: false } },
    );
    expect(off).not.toContain('cache_source');
    expect(off).not.toContain('issue-tracker');
  });
});

/**
 * M54.8 — one product brief opens every prompt. It describes the app as it is
 * today, names no tool and leaves the knowledge bundle to the capability, so
 * every grant hears it whole.
 */
describe('buildSystemPrompt opens with the product brief', () => {
  /** Every grant shape a line branches on, from everything to nothing. */
  const GRANTS: PromptGrant[] = [
    FULL,
    { ...FULL, attended: false },
    { ...FULL, shell: false },
    holding(['get_note']),
    holding(['open_note', 'propose_organize'], { shell: true }),
    holding([]),
    holding([], { attended: false }),
  ];

  it('is a context fragment that names no tool', () => {
    const brief = SYSTEM_FRAGMENTS.find((fragment) => fragment.id === 'brief');
    expect(brief?.text).toBe(PRODUCT_BRIEF);
    expect(brief?.kind).toBe('context');
    expect(brief?.uses).toEqual([]);
    expect(SYSTEM_FRAGMENTS.slice(0, 2).map((fragment) => fragment.id)).toEqual([
      'identity',
      'brief',
    ]);
  });

  it('says the identity line, then the brief verbatim, to every grant', () => {
    for (const grant of GRANTS) {
      for (const capabilities of [[], ['knowledge']]) {
        for (const connectors of [true, false]) {
          for (const serverRules of [false, true]) {
            const prompt = buildSystemPrompt(
              { kind: 'inbox' },
              { grant, capabilities, connectors, issuePrefixes: 'KES' },
              serverRules,
            );
            expect(lines(prompt)[0]).toBe(IDENTITY);
            expect(prompt.startsWith(`${IDENTITY}\n${PRODUCT_BRIEF}\n`)).toBe(true);
          }
        }
      }
    }
  });

  it('tells a run that never declared knowledge nothing of the bundle (M34.1.3)', () => {
    // The brief goes to every run, so it carries none of what only the
    // runs declaring `knowledge` may hear.
    for (const grant of GRANTS) {
      const prompt = buildSystemPrompt(
        { kind: 'none' },
        { grant, connectors: true, issuePrefixes: 'KES' },
      );
      expect(prompt.toLowerCase(), JSON.stringify([...grant.tools])).not.toContain('knowledge');
    }
  });
});

/**
 * M91.17 — a file the person attached is named with the reader that opens
 * it, and only to a run that holds that reader (CV-19); a run that holds
 * none is told it can't open the file, so it says so rather than guessing.
 */
describe('buildSystemPrompt says what opens each attached file', () => {
  const PDF = 'attachments/report.pdf';
  const DOCX = 'attachments/brief.docx';
  const BOARD = 'attachments/plan.canvas';
  const SONG = 'attachments/theme.mp3';
  const SHOT = 'attachments/screen.png';

  /** The prompt's lines about what was attached. */
  const attachedLines = (attachments: string[], grant: PromptGrant) =>
    lines(buildSystemPrompt({ kind: 'none' }, { grant, attachments })).filter((line) =>
      line.startsWith('The person attached'),
    );

  it('reads each kind with the reader the file-kinds table gives it', () => {
    expect(attachmentReader(PDF)).toBe('Read');
    expect(attachmentReader(SHOT)).toBe('Read');
    expect(attachmentReader('attachments/notes.md')).toBe('Read');
    expect(attachmentReader('attachments/rows.csv')).toBe('Read');
    expect(attachmentReader(DOCX)).toBe('read_document');
    expect(attachmentReader('attachments/deck.pptx')).toBe('read_document');
    expect(attachmentReader('attachments/model.xlsx')).toBe('read_document');
    expect(attachmentReader(BOARD)).toBe('read_canvas');
    // Nothing a run holds opens these.
    for (const path of [SONG, 'attachments/clip.mov', 'attachments/old.doc', 'attachments/a.zip']) {
      expect(attachmentReader(path), path).toBeNull();
    }
    expect(attachmentReader('attachments/mystery')).toBeNull();
  });

  it('tells a run that holds Read to open an attached PDF with it', () => {
    expect(attachedLines([PDF], { ...FULL, read: true })).toEqual([
      'The person attached `attachments/report.pdf`: open it with your Read tool.',
    ]);
  });

  it('tells a run without a reader that it can’t open the file', () => {
    const closed = [
      "The person attached `attachments/report.pdf`, which you can't open here: nothing this conversation holds reads it. If the question needs what it holds, say so.",
    ];
    // A read limit withdraws Read (M53.5), and a grant that never said so
    // holds none.
    expect(attachedLines([PDF], { ...FULL, read: false })).toEqual(closed);
    expect(attachedLines([PDF], FULL)).toEqual(closed);
    // An Office file is read_document's, and Read can't parse one.
    expect(attachedLines([DOCX], holding(['get_note'], { read: true }))).toEqual([
      "The person attached `attachments/brief.docx`, which you can't open here: nothing this conversation holds reads it. If the question needs what it holds, say so.",
    ]);
  });

  it('names cerebro’s reader only to a run that holds it, and gathers files by reader', () => {
    const grant: PromptGrant = { ...FULL, read: true };
    expect(attachedLines([DOCX, BOARD, PDF, SHOT, SONG, 'attachments/old.doc'], grant)).toEqual([
      'The person attached `attachments/brief.docx`: open it with read_document.',
      'The person attached `attachments/plan.canvas`: open it with read_canvas.',
      'The person attached `attachments/report.pdf` and `attachments/screen.png`: open them with your Read tool.',
      "The person attached `attachments/theme.mp3` and `attachments/old.doc`, which you can't open here: nothing this conversation holds reads them. If the question needs what they hold, say so.",
    ]);
    const without = holding(
      [...FULL.tools].filter((name) => name !== 'read_document'),
      { read: true },
    );
    expect(attachedLines([DOCX, PDF], without)).toEqual([
      'The person attached `attachments/report.pdf`: open it with your Read tool.',
      "The person attached `attachments/brief.docx`, which you can't open here: nothing this conversation holds reads it. If the question needs what it holds, say so.",
    ]);
  });

  it('declares exactly the cerebro tool each line names, and says Read only to a run holding it', () => {
    const files = [DOCX, BOARD, PDF, SHOT, SONG];
    for (const read of [true, false, undefined]) {
      for (const tools of [[...FULL.tools], ['read_document'], ['read_canvas'], []]) {
        const grant = holding(tools, read === undefined ? {} : { read });
        for (const fragment of attachmentFragments(files, grant)) {
          expect(mentionedTools(fragment.text), fragment.id).toEqual([...fragment.uses].sort());
          for (const tool of fragment.uses) expect(grant.tools.has(tool), tool).toBe(true);
          expect(fragment.text.includes('Read tool'), fragment.id).toBe(
            fragment.id === 'attached-Read',
          );
          if (fragment.text.includes('Read tool')) expect(grant.read).toBe(true);
        }
        // Every file is said once, opened or not.
        const said = attachmentFragments(files, grant)
          .map((f) => f.text)
          .join('\n');
        for (const file of files) expect(said.split(`\`${file}\``).length - 1, file).toBe(1);
      }
    }
  });

  it('says nothing about attachments when none are attached, and no retired term when some are', () => {
    expect(buildSystemPrompt({ kind: 'none' }, { grant: FULL, attachments: [] })).toBe(
      buildSystemPrompt({ kind: 'none' }, { grant: FULL }),
    );
    for (const read of [true, false]) {
      const prompt = buildSystemPrompt(
        { kind: 'inbox' },
        { grant: { ...FULL, read }, attachments: [PDF, DOCX, BOARD, SONG] },
      ).toLowerCase();
      for (const term of RETIRED.terms) expect(prompt).not.toContain(term.toLowerCase());
    }
  });
});
