import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * The dev skills under `.claude/skills/` are tracked, and AGENTS.md's Dev
 * skills section lists them (M53.23). This holds that list to the folders on
 * disk, each skill's frontmatter to what Claude Code loads, and each file to
 * the public repo it lives in: no home path, no email, no cited repo path that
 * has moved. Which CV ids a skill may cite is `conventions.test.ts`'s job.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = '.claude/skills';
const SECTION = '## Dev skills';

// Claude Code's limits on a name and a description. The name pattern is a
// little stricter than lowercase, digits and hyphens: no hyphen at either end,
// and never two in a row.
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;
// A skill is a checklist that points at its sources, not a second copy of them.
const BODY_MAX_LINES = 80;

const LISTED = /^- `([a-z0-9-]+)` — /gm;
const HOME = /\/(Users|home)\//;
const EMAIL = /[\w.%+-]+@[\w-]+(\.[\w-]+)*\.[a-z]{2,}/i;
const CODE_SPAN = /`([^`\n]+)`/g;
/** A backticked word under one of these roots is a repo path, so it must exist. */
const REPO_PATH =
  /^(src|src-tauri|shared|scripts|e2e|conformance|demo-vault|\.github|\.husky|\.claude\/skills|docs\/superpowers)\//;
/** A placeholder or a glob names no one file. */
const PATTERN = /[<>*{}]/;

/** One folder under `.claude/skills`, with its SKILL.md text, or null when it has none. */
interface SkillDir {
  name: string;
  text: string | null;
}

/** The names the Dev skills section lists, in order. */
function listedSkills(agentsMd: string): string[] {
  const lines = agentsMd.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trimEnd() === SECTION);
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,2} /.test(line));
  const section = rest.slice(0, end === -1 ? undefined : end).join('\n');
  return [...section.matchAll(LISTED)].map((match) => match[1]);
}

/** Repo paths a skill cites in backticks, each cut at its first `:` (`path::test`, `path:12`). */
function citedPaths(text: string): string[] {
  const words = [...text.matchAll(CODE_SPAN)].flatMap((match) => match[1].split(/\s+/));
  const paths = words
    .filter((word) => !PATTERN.test(word))
    .map((word) => word.replace(/^\.\//, '').split(':')[0])
    .filter((path) => REPO_PATH.test(path));
  return [...new Set(paths)];
}

function skillProblems(dir: string, text: string, exists: (path: string) => boolean): string[] {
  const split = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (split === null) return [`${dir}: no frontmatter`];
  let meta: unknown;
  try {
    meta = parse(split[1]);
  } catch {
    return [`${dir}: frontmatter does not parse`];
  }
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    return [`${dir}: frontmatter is not a mapping`];
  }
  const { name, description } = meta as Record<string, unknown>;
  const problems: string[] = [];

  if (typeof name !== 'string') {
    problems.push(`${dir}: frontmatter has no name`);
  } else {
    if (name !== dir) problems.push(`${dir}: frontmatter names "${name}", not its folder`);
    if (!NAME.test(name) || name.length > NAME_MAX) {
      problems.push(
        `${dir}: a name is lowercase words joined by hyphens, at most ${NAME_MAX} characters`,
      );
    }
  }
  if (typeof description !== 'string' || description.trim() === '') {
    problems.push(`${dir}: description is empty`);
  } else if (description.length > DESCRIPTION_MAX) {
    problems.push(
      `${dir}: description runs ${description.length} characters; the cap is ${DESCRIPTION_MAX}`,
    );
  }

  if (HOME.test(text)) problems.push(`${dir}: holds a home path`);
  if (EMAIL.test(text)) problems.push(`${dir}: holds an email address`);
  const lines = split[2].trim().split(/\r?\n/).length;
  if (lines > BODY_MAX_LINES) {
    problems.push(`${dir}: body runs ${lines} lines; the cap is ${BODY_MAX_LINES}`);
  }
  for (const path of citedPaths(split[2])) {
    if (!exists(path)) problems.push(`${dir}: cites ${path}, which does not exist`);
  }
  return problems;
}

/**
 * Everything wrong with the listed skills against the folders on disk: the
 * list first, then each folder's SKILL.md. `exists` answers for a repo path.
 */
function auditSkills(
  listed: readonly string[],
  onDisk: readonly SkillDir[],
  exists: (path: string) => boolean,
): string[] {
  const problems: string[] = [];
  const folders = new Set(onDisk.map((dir) => dir.name));
  listed.forEach((name, at) => {
    if (listed.indexOf(name) !== at) problems.push(`${name}: listed twice`);
    else if (!folders.has(name)) {
      problems.push(`${name}: listed in AGENTS.md, but ${SKILLS}/${name} does not exist`);
    }
  });
  for (const { name } of onDisk) {
    if (!listed.includes(name)) problems.push(`${name}: on disk, but AGENTS.md does not list it`);
  }
  for (const { name, text } of onDisk) {
    if (text === null) problems.push(`${name}: no SKILL.md`);
    else problems.push(...skillProblems(name, text, exists));
  }
  return problems;
}

/**
 * Every folder under `.claude/skills` but a dot-folder. A file there, Finder's
 * `.DS_Store` say, is no skill.
 */
function skillsOnDisk(): SkillDir[] {
  const root = join(REPO, SKILLS);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const file = join(root, name, 'SKILL.md');
      return { name, text: existsSync(file) ? readFileSync(file, 'utf8') : null };
    });
}

describe('AGENTS.md dev skills', () => {
  it('the list names exactly the skills on disk, and each one is sound', () => {
    const listed = listedSkills(readFileSync(join(REPO, 'AGENTS.md'), 'utf8'));
    expect(listed.length).toBeGreaterThan(0);
    const exists = (path: string) => existsSync(join(REPO, path));
    expect(auditSkills(listed, skillsOnDisk(), exists)).toEqual([]);
  });
});

describe('listedSkills', () => {
  it('reads only the Dev skills section, up to the next heading', () => {
    const md = [
      '# Rules',
      '',
      '## Commands',
      '',
      '- `not-a-skill` — the same shape, in another section',
      '',
      SECTION,
      '',
      'A paragraph naming `prose-only`.',
      '',
      '- `first` — one line',
      '- `second-one` — another',
      '',
      '## Later',
      '',
      '- `after` — past the section',
      '',
    ].join('\n');
    expect(listedSkills(md)).toEqual(['first', 'second-one']);
  });

  it('lists nothing when the section is missing', () => {
    expect(listedSkills('# Rules\n\n- `first` — one line\n')).toEqual([]);
  });
});

describe('auditSkills', () => {
  const skill = (name: string, description = 'Does one thing. Use when asked.', body = '') =>
    ['---', `name: ${name}`, `description: ${description}`, '---', '', body, ''].join('\n');
  const exists = (path: string) => path === 'src' || path === 'src/real.ts';
  const check = (text: string | null, dir = 'good-skill') =>
    auditSkills([dir], [{ name: dir, text }], exists);

  it('passes a listed skill with sound frontmatter that cites real paths', () => {
    expect(check(skill('good-skill', undefined, '- Read `src/real.ts` and `src`.'))).toEqual([]);
  });

  it('reports a listed skill with no folder', () => {
    expect(auditSkills(['ghost'], [], exists)).toEqual([
      'ghost: listed in AGENTS.md, but .claude/skills/ghost does not exist',
    ]);
  });

  it('reports a folder the list leaves out', () => {
    expect(auditSkills([], [{ name: 'stray', text: skill('stray') }], exists)).toEqual([
      'stray: on disk, but AGENTS.md does not list it',
    ]);
  });

  it('reports a skill listed twice', () => {
    const dir = { name: 'good-skill', text: skill('good-skill') };
    expect(auditSkills(['good-skill', 'good-skill'], [dir], exists)).toEqual([
      'good-skill: listed twice',
    ]);
  });

  it('reports a folder without SKILL.md', () => {
    expect(check(null)).toEqual(['good-skill: no SKILL.md']);
  });

  it('reports a file with no frontmatter, or frontmatter that does not parse', () => {
    expect(check('# good-skill\n\n- A bullet.\n')).toEqual(['good-skill: no frontmatter']);
    expect(check('---\nname: [good-skill\n---\n')).toEqual([
      'good-skill: frontmatter does not parse',
    ]);
    expect(check('---\n- good-skill\n---\n')).toEqual(['good-skill: frontmatter is not a mapping']);
  });

  it('reports a name that is missing, or is not the folder name', () => {
    expect(check('---\ndescription: Does one thing.\n---\n')).toEqual([
      'good-skill: frontmatter has no name',
    ]);
    expect(check(skill('other-skill'))).toEqual([
      'good-skill: frontmatter names "other-skill", not its folder',
    ]);
  });

  it('reports a name Claude Code would refuse', () => {
    const long = 'a'.repeat(65);
    const rule = 'a name is lowercase words joined by hyphens, at most 64 characters';
    expect(check(skill('Good_Skill'), 'Good_Skill')).toEqual([`Good_Skill: ${rule}`]);
    expect(check(skill(long), long)).toEqual([`${long}: ${rule}`]);
  });

  it('reports a description that is empty or too long', () => {
    expect(check(skill('good-skill', ''))).toEqual(['good-skill: description is empty']);
    expect(check(skill('good-skill', 'x'.repeat(1025)))).toEqual([
      'good-skill: description runs 1025 characters; the cap is 1024',
    ]);
  });

  it('reports a home path or an email address, since the repo is public', () => {
    expect(check(skill('good-skill', undefined, '- Run it from /Users/someone/repo.'))).toEqual([
      'good-skill: holds a home path',
    ]);
    expect(check(skill('good-skill', undefined, '- Or from /home/someone/repo.'))).toEqual([
      'good-skill: holds a home path',
    ]);
    expect(check(skill('good-skill', undefined, '- Ask someone@example.com.'))).toEqual([
      'good-skill: holds an email address',
    ]);
  });

  it('reports a body over the line cap', () => {
    const body = Array.from({ length: 81 }, () => '- A bullet.').join('\n');
    expect(check(skill('good-skill', undefined, body))).toEqual([
      'good-skill: body runs 81 lines; the cap is 80',
    ]);
  });

  it('reports a cited repo path that does not exist, wherever the span cites it', () => {
    const body = [
      '- See `src/gone.ts::its test` and `src/real.ts:12`.',
      '- Run `pnpm vitest run src/missing.test.ts`.',
    ].join('\n');
    expect(check(skill('good-skill', undefined, body))).toEqual([
      'good-skill: cites src/gone.ts, which does not exist',
      'good-skill: cites src/missing.test.ts, which does not exist',
    ]);
  });

  it('skips placeholders, globs, module paths and words outside the checked roots', () => {
    const body = [
      '- `e2e/<name>.spec.ts`, `src/**/*.ts` and `repos/{owner}/{repo}/alerts`.',
      '- `policy::table`, `AGENTS.md`, `notes/gone.md` and `./src/real.ts`.',
    ].join('\n');
    expect(check(skill('good-skill', undefined, body))).toEqual([]);
  });
});
