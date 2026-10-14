import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * AGENTS.md's rules carry ids (M53.19). A rule declares a permanent `CV-NN`
 * in its bold lead and ends on an `enforced:` line: `prose` when only review
 * holds it, or backticked pointers, each a repo path or `path::text` that the
 * file must contain. This file resolves every pointer, so a renamed test or a
 * moved file fails here, beside the rule that leaned on it.
 */

const REPO = join(__dirname, '..');
const AGENTS = 'AGENTS.md';
const SECTION = '## Conventions that will bite you';

// A retired rule's id goes here, so it is never handed out again.
const RETIRED: readonly string[] = [];

/** What the audit reads of the tree, by repo-relative path. */
interface Fs {
  exists(path: string): boolean;
  isFile(path: string): boolean;
  read(path: string): string;
}

/** A file that may name a rule by its id. */
interface Citation {
  source: string;
  text: string;
}

interface Block {
  lines: string[];
  /** Every bold `**CV-NN` in the block, repeats included. */
  ids: string[];
}

const DECLARATION = /\*\*(CV-\d{2})\b/g;
const CITED = /\bCV-\d{2}\b/g;
const ENFORCED = /^\s*enforced: (.+)$/;
const POINTERS = /^`[^`]+`(?:, `[^`]+`)*$/;
const MALFORMED = 'enforced: is prose or backticked pointers';

/**
 * Blocks as the rules are written: one starts at a column-0 `- ` or `#` line,
 * or at the first line after a blank one; every other line continues it.
 * Fenced code is skipped.
 */
function blocks(md: string): Block[] {
  const out: Block[] = [];
  let fenced = false;
  let afterBlank = true;
  for (const line of md.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (line.trim() === '') {
      afterBlank = true;
      continue;
    }
    const ids = [...line.matchAll(DECLARATION)].map((match) => match[1]);
    const current = out.at(-1);
    if (current === undefined || afterBlank || /^(- |#)/.test(line)) {
      out.push({ lines: [line], ids });
    } else {
      current.lines.push(line);
      current.ids.push(...ids);
    }
    afterBlank = false;
  }
  return out;
}

function declaredIds(md: string): string[] {
  return blocks(md).flatMap((block) => block.ids);
}

/** One pointer: `path`, or `path::needle` split at the first `::`. */
function pointerProblem(id: string, pointer: string, fs: Fs): string | null {
  const cut = pointer.indexOf('::');
  const path = cut === -1 ? pointer : pointer.slice(0, cut);
  const needle = cut === -1 ? null : pointer.slice(cut + 2);
  if (path === '' || needle === '') return `${id}: ${MALFORMED}`;
  if (path.startsWith('/') || path.split('/').includes('..')) {
    return `${id}: a pointer must stay inside the repo: ${path}`;
  }
  if (posix.normalize(path).toLowerCase() === AGENTS.toLowerCase()) {
    return `${id}: AGENTS.md cannot enforce itself`;
  }
  if (!fs.exists(path)) return `${id}: nothing at ${path}`;
  if (needle === null) return null;
  if (!fs.isFile(path)) return `${id}: ${path} is not a file, so it cannot hold ${needle}`;
  if (!fs.read(path).includes(needle)) return `${id}: ${path} does not contain "${needle}"`;
  return null;
}

function valueProblems(id: string, value: string, fs: Fs): string[] {
  if (value === 'prose') return [];
  if (!POINTERS.test(value)) {
    const outsideSpans = value.replace(/`[^`]*`/g, '');
    return [/\bprose\b/.test(outsideSpans) ? `${id}: prose stands alone` : `${id}: ${MALFORMED}`];
  }
  return value
    .slice(1, -1)
    .split('`, `')
    .flatMap((pointer) => pointerProblem(id, pointer, fs) ?? []);
}

/**
 * Every column-0 bullet under SECTION is a rule, so each must carry an id. A
 * section with no bullets fails too, so a parser that lost them cannot pass.
 */
function sectionProblems(parsed: Block[]): string[] {
  const start = parsed.findIndex((block) => block.lines[0].trimEnd() === SECTION);
  if (start === -1) return [`no "${SECTION}" section`];
  const rest = parsed.slice(start + 1);
  const end = rest.findIndex((block) => /^#{1,2} /.test(block.lines[0]));
  const bullets = rest
    .slice(0, end === -1 ? undefined : end)
    .filter((block) => block.lines[0].startsWith('- '));
  if (bullets.length === 0) return [`"${SECTION}" has no bullets`];
  return bullets
    .filter((block) => block.ids.length === 0)
    .map((block) => `a convention without an id: "${block.lines[0].trimEnd()}"`);
}

function audit(
  md: string,
  fs: Fs,
  citations: readonly Citation[],
  retired: readonly string[],
): string[] {
  const problems: string[] = [];
  const declared = new Set<string>();
  const parsed = blocks(md);

  for (const { lines, ids } of parsed) {
    const enforced = lines.flatMap((line, at) => {
      const match = ENFORCED.exec(line);
      return match === null ? [] : [{ at, line: line.trim(), value: match[1].trim() }];
    });
    if (ids.length === 0) {
      problems.push(...enforced.map(({ line }) => `enforced: line outside a rule: "${line}"`));
      continue;
    }
    const distinct = [...new Set(ids)];
    for (const id of distinct) {
      if (declared.has(id) || ids.indexOf(id) !== ids.lastIndexOf(id)) {
        problems.push(`${id} is declared twice`);
      }
      if (retired.includes(id)) problems.push(`${id} is retired and may not come back`);
      declared.add(id);
    }
    const [id, other] = distinct;
    if (other !== undefined) {
      problems.push(`a block declares two rules: ${id}, ${other}`);
      continue;
    }
    const [only, extra] = enforced;
    if (only === undefined) {
      problems.push(`${id} has no enforced: line`);
    } else if (extra !== undefined) {
      problems.push(`${id} has more than one enforced: line`);
    } else {
      if (only.at !== lines.length - 1) {
        problems.push(`${id}: enforced: must be the rule's last line`);
      }
      problems.push(...valueProblems(id, only.value, fs));
    }
  }

  for (const { source, text } of citations) {
    for (const id of new Set(text.match(CITED) ?? [])) {
      if (!declared.has(id)) problems.push(`${source} cites ${id}, which no rule declares`);
    }
  }

  return [...problems, ...sectionProblems(parsed)];
}

const repoFs: Fs = {
  exists: (path) => existsSync(join(REPO, path)),
  isFile: (path) => statSync(join(REPO, path)).isFile(),
  read: (path) => readFileSync(join(REPO, path), 'utf8'),
};

/** AGENTS.md cites its own ids, and so may any skill under `.claude/skills`. */
function repoCitations(md: string): Citation[] {
  const skills = join(REPO, '.claude', 'skills');
  const paths = existsSync(skills)
    ? readdirSync(skills)
        .sort()
        .map((name) => `.claude/skills/${name}/SKILL.md`)
        .filter((path) => existsSync(join(REPO, path)))
    : [];
  return [
    { source: AGENTS, text: md },
    ...paths.map((path) => ({ source: path, text: repoFs.read(path) })),
  ];
}

describe('AGENTS.md', () => {
  it('conventions are sound: every rule has an id, and every pointer resolves', () => {
    const md = repoFs.read(AGENTS);
    expect(audit(md, repoFs, repoCitations(md), RETIRED)).toEqual([]);
    expect(declaredIds(md).length).toBeGreaterThan(0);
  });
});

describe('audit', () => {
  const files = new Map([['src/guard.test.ts', "it('holds the line', () => {});\n"]]);
  const dirs = new Set(['src']);
  const fakeFs: Fs = {
    exists: (path) => files.has(path) || dirs.has(path),
    isFile: (path) => files.has(path),
    read: (path) => files.get(path) ?? '',
  };
  const GOOD = '- **CV-01 Guarded**: a rule.\n  enforced: `src/guard.test.ts::holds the line`';

  /** A document whose Conventions section holds GOOD, then `rest`. */
  const doc = (...rest: string[]) => ['# Rules', '', SECTION, '', GOOD, ...rest, ''].join('\n');
  const check = (md: string, citations: Citation[] = [], retired: string[] = []) =>
    audit(md, fakeFs, citations, retired);

  it('passes bullet and paragraph rules, prose, a directory, and skips fenced code', () => {
    const md = [
      '# Rules',
      '',
      SECTION,
      '',
      'Rules carry ids.',
      '',
      GOOD,
      '- **CV-02 Reviewed**: only review holds it.',
      '  enforced: prose',
      '',
      '## Elsewhere',
      '',
      'A paragraph rule, **CV-03 bold over',
      'two lines**, like the hooks sentence.',
      'enforced: `src`, `src/guard.test.ts`',
      '',
      '```md',
      'enforced: an example, not a rule',
      '```',
      '',
      'See CV-02 and CV-03.',
      '',
    ].join('\n');
    expect(check(md, [{ source: AGENTS, text: md }])).toEqual([]);
    expect(declaredIds(md)).toEqual(['CV-01', 'CV-02', 'CV-03']);
  });

  it('reports a rule with no enforced: line', () => {
    expect(check(doc('- **CV-02 Bare**: nothing names its enforcer.'))).toEqual([
      'CV-02 has no enforced: line',
    ]);
  });

  it('reports a second enforced: line', () => {
    expect(check(doc('- **CV-02 Twice**: a rule.\n  enforced: prose\n  enforced: prose'))).toEqual([
      'CV-02 has more than one enforced: line',
    ]);
  });

  it('reports an enforced: line that is not the last', () => {
    expect(check(doc('- **CV-02 Early**: a rule.\n  enforced: prose\n  More text.'))).toEqual([
      "CV-02: enforced: must be the rule's last line",
    ]);
  });

  it('reports an id declared twice', () => {
    expect(check(doc(GOOD))).toEqual(['CV-01 is declared twice']);
  });

  it('reports a retired id', () => {
    expect(check(doc(), [], ['CV-01'])).toEqual(['CV-01 is retired and may not come back']);
  });

  it('reports two declarations in one block', () => {
    expect(check(doc('- **CV-02 One** and **CV-03 Two**: a rule.\n  enforced: prose'))).toEqual([
      'a block declares two rules: CV-02, CV-03',
    ]);
  });

  it('reports an enforced: line outside a rule', () => {
    expect(check(doc('', 'A paragraph that is no rule.', 'enforced: prose'))).toEqual([
      'enforced: line outside a rule: "enforced: prose"',
    ]);
  });

  it('reports a malformed enforced: value', () => {
    expect(check(doc('- **CV-02 Unquoted**: a rule.\n  enforced: src/guard.test.ts'))).toEqual([
      'CV-02: enforced: is prose or backticked pointers',
    ]);
  });

  it('reports prose mixed with a pointer', () => {
    expect(check(doc('- **CV-02 Both**: a rule.\n  enforced: prose, `src/guard.test.ts`'))).toEqual(
      ['CV-02: prose stands alone'],
    );
  });

  it('reports a pointer at nothing', () => {
    expect(check(doc('- **CV-02 Gone**: a rule.\n  enforced: `src/gone.test.ts`'))).toEqual([
      'CV-02: nothing at src/gone.test.ts',
    ]);
  });

  it('reports a pointer outside the repo, absolute or through ..', () => {
    expect(check(doc('- **CV-02 Abs**: a rule.\n  enforced: `/etc/hosts`'))).toEqual([
      'CV-02: a pointer must stay inside the repo: /etc/hosts',
    ]);
    expect(check(doc('- **CV-02 Up**: a rule.\n  enforced: `src/../../x.ts`'))).toEqual([
      'CV-02: a pointer must stay inside the repo: src/../../x.ts',
    ]);
  });

  it('reports a rule that points at AGENTS.md', () => {
    expect(check(doc('- **CV-02 Self**: a rule.\n  enforced: `./AGENTS.md`'))).toEqual([
      'CV-02: AGENTS.md cannot enforce itself',
    ]);
  });

  it('reports a needle on a directory', () => {
    expect(check(doc('- **CV-02 Dir**: a rule.\n  enforced: `src::holds the line`'))).toEqual([
      'CV-02: src is not a file, so it cannot hold holds the line',
    ]);
  });

  it('reports a needle the file does not contain, as after a rename', () => {
    expect(
      check(doc('- **CV-02 Renamed**: a rule.\n  enforced: `src/guard.test.ts::lets it slide`')),
    ).toEqual(['CV-02: src/guard.test.ts does not contain "lets it slide"']);
  });

  it('reports an id AGENTS.md cites but no rule declares', () => {
    const md = doc('', 'See CV-07 first.');
    expect(check(md, [{ source: AGENTS, text: md }])).toEqual([
      'AGENTS.md cites CV-07, which no rule declares',
    ]);
  });

  it('reports an id a skill file cites but no rule declares', () => {
    const md = doc();
    const skill = '.claude/skills/verify-ui/SKILL.md';
    expect(
      check(md, [
        { source: AGENTS, text: md },
        { source: skill, text: 'Mind CV-09.' },
      ]),
    ).toEqual([`${skill} cites CV-09, which no rule declares`]);
  });

  it('reports a Conventions bullet with no id', () => {
    expect(check(doc('- **Unnumbered**: a rule.'))).toEqual([
      'a convention without an id: "- **Unnumbered**: a rule."',
    ]);
  });

  it('reports a Conventions section with no bullets', () => {
    const md = ['# Rules', '', SECTION, '', 'Only prose.', '', '## Elsewhere', '', GOOD, ''];
    expect(check(md.join('\n'))).toEqual([`"${SECTION}" has no bullets`]);
  });

  it('reports a missing Conventions section', () => {
    expect(check(['# Rules', '', GOOD, ''].join('\n'))).toEqual([`no "${SECTION}" section`]);
  });
});
