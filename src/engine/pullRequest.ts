import type { Entry, Schema } from './types';

/** The URL boundary replays src-tauri/fixtures/pr-urls.json with forge.rs. */
export interface PullRequestUrl {
  owner: string;
  repo: string;
  number: number;
  canonical: string;
  key: string;
}
export function parsePullRequestUrl(raw: string): PullRequestUrl | null {
  if (/[\s\p{White_Space}\p{Cc}%\\]/u.test(raw)) return null;
  const authority = /^https:\/\/(?:www\.)?github\.com(?=\/)/i.exec(raw);
  if (authority === null) return null;
  const match =
    /^\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})\/pull\/([1-9][0-9]{0,9})(?:\/(?:files|commits|checks))?(?:[?#].*)?$/.exec(
      raw.slice(authority[0].length),
    );
  if (match === null || match[2] === '.' || match[2] === '..') return null;
  const [, owner, repo, digits] = match;
  const canonical = `https://github.com/${owner}/${repo}/pull/${digits}`;
  return { owner, repo, number: Number(digits), canonical, key: canonical.toLowerCase() };
}

export type PrCheck =
  | { kind: 'check_run'; name: string | null; status: string | null; conclusion: string | null }
  | { kind: 'status_context'; name: string | null; state: string | null }
  | { kind: 'unknown' };
export interface PullRequest {
  number: number;
  url: string;
  title: string | null;
  state: string;
  isDraft: boolean | null;
  mergedAt: string | null;
  closedAt: string | null;
  headRefName: string | null;
  baseRefName: string | null;
  author: string | null;
  body: string | null;
  reviewDecision: string | null;
  mergeStateStatus: string | null;
  updatedAt: string | null;
  checks: PrCheck[] | null;
}
export type PrFailure =
  | 'invalid_url'
  | 'gh_missing'
  | 'not_signed_in'
  | 'not_found'
  | 'offline'
  | 'rate_limited'
  | 'gh_outdated'
  | 'timed_out'
  | 'unreadable'
  | 'failed';
export type PrRead =
  { state: 'read'; checkedAt: string; pr: PullRequest } | { state: PrFailure; checkedAt: string };
export type PrReadiness = 'ready' | 'not_ready' | 'no_checks' | 'checks_unknown';
export type CheckState = 'passing' | 'failing' | 'running' | 'unknown';

export function checkState(check: PrCheck): CheckState {
  if (check.kind === 'unknown') return 'unknown';
  if (check.kind === 'status_context') {
    if (check.state === 'SUCCESS') return 'passing';
    if (check.state === 'FAILURE' || check.state === 'ERROR') return 'failing';
    return check.state === 'PENDING' || check.state === 'EXPECTED' ? 'running' : 'unknown';
  }
  if (
    check.status === 'QUEUED' ||
    check.status === 'IN_PROGRESS' ||
    check.status === 'WAITING' ||
    check.status === 'PENDING' ||
    check.status === 'REQUESTED'
  )
    return 'running';
  if (check.status !== 'COMPLETED') return 'unknown';
  if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check.conclusion ?? '')) return 'passing';
  if (
    ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'].includes(
      check.conclusion ?? '',
    )
  )
    return 'failing';
  return 'unknown';
}

export function readinessOf(read: PrRead): PrReadiness | null {
  if (read.state !== 'read') return 'checks_unknown';
  const { pr } = read;
  if (pr.state === 'MERGED' || pr.state === 'CLOSED') return null;
  if (pr.state !== 'OPEN') return 'checks_unknown';
  if (pr.isDraft === true) return 'not_ready';
  if (pr.isDraft === null || pr.checks === null) return 'checks_unknown';
  if (pr.checks.length === 0) return 'no_checks';
  const states = pr.checks.map(checkState);
  if (states.includes('failing')) return 'not_ready';
  if (states.includes('unknown')) return 'checks_unknown';
  return states.includes('running') ? 'not_ready' : 'ready';
}

/** Conservatively omit code, including container fences and HTML code blocks.
 * The scan only discovers links: ambiguous indentation may hide a link but
 * can never make code cause an authenticated gh read. */
function withoutContainers(line: string): string {
  let content = line;
  // List and quote markers may alternate. Consume only the list's actual
  // padding: five spaces after a marker leave four spaces of indented code.
  for (let depth = 0; depth < 100; depth++) {
    const quote = /^ {0,3}>[ \t]?/.exec(content);
    if (quote !== null) {
      content = content.slice(quote[0].length);
      continue;
    }
    const list = /^ {0,3}(?:[-+*]|\d+[.)])(?=[ \t])/.exec(content);
    if (list === null) return content;
    const rest = content.slice(list[0].length);
    const padding = /^ +/.exec(rest)?.[0].length ?? 0;
    // A tab is conservatively kept as indentation rather than turned into prose.
    content = rest.slice(padding > 4 ? 1 : padding);
  }
  return '';
}

function proseOnly(markdown: string): string {
  let fence: { char: string; length: number } | null = null;
  const lines = markdown
    .split('\n')
    .map((line) => {
      const content = withoutContainers(line);
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(content);
      if (fence !== null) {
        if (
          marker !== null &&
          marker[1][0] === fence.char &&
          marker[1].length >= fence.length &&
          content.slice(marker[0].length).trim() === ''
        )
          fence = null;
        return '';
      }
      if (marker !== null) {
        fence = { char: marker[1][0], length: marker[1].length };
        return '';
      }
      return /^(?: {4}| {0,3}\t)/.test(content) ? '' : line;
    })
    .join('\n')
    .replace(/<(pre|code)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ');
  const runs = [...lines.matchAll(/`+/g)];
  const next = new Map<number, number>();
  const same = new Map<number, number>();
  for (let i = runs.length - 1; i >= 0; i--) {
    const length = runs[i][0].length;
    const later = same.get(length);
    if (later !== undefined) next.set(i, later);
    same.set(length, i);
  }
  let out = '',
    at = 0;
  for (let i = 0; i < runs.length; i++) {
    const close = next.get(i);
    if (close === undefined) continue;
    out += lines.slice(at, runs[i].index) + ' ';
    at = runs[close].index + runs[close][0].length;
    i = close;
  }
  return out + lines.slice(at);
}

function proseUrls(markdown: string): string[] {
  const prose = proseOnly(markdown);
  return [...prose.matchAll(/https:\/\/[^\s<>"`]+/gi)].flatMap((m) => {
    if (m.index > 0 && /[\w/]/.test(prose[m.index - 1])) return [];
    return [m[0].replace(/[),.;:\]}]+$/, '')];
  });
}
export function findPullRequestUrls(markdown: string): PullRequestUrl[] {
  const found = new Map<string, PullRequestUrl>();
  for (const raw of proseUrls(markdown)) {
    const parsed = parsePullRequestUrl(raw);
    if (parsed !== null && !found.has(parsed.key)) found.set(parsed.key, parsed);
  }
  return [...found.values()];
}

/** Exact URL properties count even if they are not in the visible heading. */
export function propertyPullRequestUrls(entry: Entry): PullRequestUrl[] {
  const values = Object.values(entry.properties).flatMap((value) =>
    Array.isArray(value) ? value : [value],
  );
  const urls = values
    .flatMap((value) => (typeof value === 'string' ? [parsePullRequestUrl(value)] : []))
    .filter((v) => v !== null);
  return [...new Map(urls.map((url) => [url.key, url])).values()];
}

export interface PrOrigin {
  name: string;
  evidence: 'session link' | 'footer' | 'trailer' | 'bot author' | 'branch prefix';
  source: string;
}
/** Public markers checked 2026-10-15. These are hints, not authorship claims.
 * Exact HTTPS hosts prevent a lookalike link from borrowing an origin. */
const SESSION_ORIGINS = [
  {
    name: 'Codex',
    host: 'chatgpt.com',
    path: /^\/codex\/tasks\/[^/?#]+$/,
    source: 'https://github.com/openai/codex/blob/main/codex-rs/cloud-tasks/src/util.rs',
  },
  {
    name: 'Cursor',
    host: 'cursor.com',
    path: /^\/agents\/[^/?#]+$/,
    source: 'https://cursor.com/docs/cloud-agent/api/endpoints',
  },
  {
    name: 'Devin',
    host: 'app.devin.ai',
    path: /^\/sessions\/[^/?#]+$/,
    source: 'https://cognition.com/blog/devin-generally-available',
  },
  {
    name: 'Jules',
    host: 'jules.google.com',
    path: /^\/session\/[^/?#]+$/,
    source: 'https://jules.google/docs/api/reference/sessions/',
  },
] as const;
const CLAUDE_SOURCE = 'https://github.com/anthropics/claude-code/issues/19366';
export function originOf(pr: PullRequest): PrOrigin | null {
  for (const row of SESSION_ORIGINS) {
    if (
      proseUrls(pr.body ?? '').some((raw) => {
        const match = /^https:\/\/([A-Za-z0-9.-]+)(\/[^?#]*)?(?:[?#].*)?$/i.exec(raw);
        return (
          match !== null && match[1].toLowerCase() === row.host && row.path.test(match[2] ?? '')
        );
      })
    )
      return { name: row.name, evidence: 'session link', source: row.source };
  }
  const body = proseOnly(pr.body ?? '').trim();
  if (
    /(?:^|\n)(?:🤖\s*)?Generated with (?:Claude Code|\[Claude Code\]\(https:\/\/(?:claude\.com\/claude-code|claude\.ai\/code)\))\.?\s*$/.test(
      body,
    )
  )
    return { name: 'Claude Code', evidence: 'footer', source: CLAUDE_SOURCE };
  if (/(?:^|\n)Co-Authored-By: Claude Code\s*$/i.test(body))
    return {
      name: 'Claude Code',
      evidence: 'trailer',
      source: 'https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md',
    };
  if (pr.headRefName?.startsWith('cursor/'))
    return {
      name: 'Cursor',
      evidence: 'branch prefix',
      source: 'https://cursor.com/docs/cloud-agent/api/endpoints',
    };
  if (pr.headRefName?.startsWith('copilot/'))
    return {
      name: 'Copilot',
      evidence: 'branch prefix',
      source: 'https://docs.github.com/en/enterprise-cloud%40latest/copilot/responsible-use/agents',
    };
  return null;
}

export interface StatusSuggestion {
  field: string;
  value: string;
  label: string;
}
export function statusSuggestion(
  entry: Entry,
  schema: Schema,
  reads: readonly (PrRead | null)[],
): StatusSuggestion | null {
  if (
    reads.length === 0 ||
    reads.some((read) => read?.state !== 'read' || read.pr.state !== 'MERGED')
  )
    return null;
  const field =
    entry.type === null
      ? undefined
      : schema.types.get(entry.type)?.fields.find((f) => f.kind === 'status');
  if (field === undefined) return null;
  const statuses = schema.statusSetFor(entry);
  if (statuses.some((s) => s.group === 'done' && s.id === schema.fieldValue(entry, field.name)))
    return null;
  const done = statuses.find((s) => s.group === 'done');
  return done === undefined ? null : { field: field.name, value: done.id, label: done.label };
}
