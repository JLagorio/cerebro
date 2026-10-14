/**
 * What a link is called, read from the URL alone (M69.2).
 *
 * An external link used to show as its raw URL in a citation chip, the
 * Sources list and the Inbox's fetch ask, though the URL already says what the
 * page is: Notion and Figma carry a slug, Linear an issue id and a slug,
 * GitHub an owner, a repo and a number. The core has no network (M26.7d), so
 * the name has to come from the URL itself, and it is never stored: a slug
 * goes stale when the page is renamed upstream, so every surface keeps the URL
 * one hover away.
 *
 * The behaviour follows Macro's `crates/unfurl` url_parsers, with deliberate
 * deviations: a host matches by EXACT suffix (Macro's `contains` names
 * `notion.so.evil.test` a Notion page); Figma reads design, file, board and
 * proto links (Macro reads design only); GitHub is added; a Linear issue reads
 * `ENG-142 Fix login` in sentence case rather than Title Case; and a URL that
 * names no page gives the service name, never a guess.
 *
 * A hand parse, because the engine's ES2022 lib has no URL class. It reads
 * ports, userinfo, IPv6 and non-ASCII (IDN) hosts as no label on purpose.
 */

export type LinkService = 'notion' | 'figma' | 'linear' | 'github';

/** A GitHub pull request or issue, for the PR chip (M69.11) to reuse. */
export interface GitHubRef {
  owner: string;
  repo: string;
  number: number;
  kind: 'pull' | 'issue';
}

export interface LinkLabel {
  service: LinkService;
  serviceName: 'Notion' | 'Figma' | 'Linear' | 'GitHub';
  /** The page's own name, or null when the URL names no page. */
  title: string | null;
  /** What to show: the title, else the service name. */
  text: string;
  github: GitHubRef | null;
}

/** Hosts in match order; the first match wins. */
const SERVICES: readonly {
  service: LinkService;
  serviceName: LinkLabel['serviceName'];
  domains: readonly string[];
}[] = [
  { service: 'notion', serviceName: 'Notion', domains: ['notion.so', 'notion.site'] },
  { service: 'figma', serviceName: 'Figma', domains: ['figma.com'] },
  { service: 'linear', serviceName: 'Linear', domains: ['linear.app'] },
  { service: 'github', serviceName: 'GitHub', domains: ['github.com'] },
];

const MAX_WORDS = 80;

/** A percent-decoded segment, or null when its escapes are malformed. */
function decode(segment: string | undefined): string | null {
  if (segment === undefined) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * A slug as words: `-` and `_` runs become one space, sentence case only when
 * the slug carries no uppercase of its own, at most 80 code points.
 */
function words(slug: string | null): string | null {
  if (slug === null) return null;
  const text = slug.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (text === '') return null;
  let points = Array.from(text);
  if (!/\p{Lu}/u.test(text)) points[0] = points[0]!.toUpperCase();
  if (points.length > MAX_WORDS) points = [...points.slice(0, MAX_WORDS - 1), '\u2026'];
  return points.join('');
}

function notionTitle(segments: readonly string[]): string | null {
  const last = decode(segments[segments.length - 1]);
  if (last === null) return null;
  const match = /^(.+)-([0-9a-fA-F]{32})$/.exec(last);
  return match === null ? null : words(match[1]!);
}

function figmaTitle(segments: readonly string[]): string | null {
  if (!['design', 'file', 'board', 'proto'].includes(segments[0] ?? '')) return null;
  return words(decode(segments[2]));
}

function linearTitle(segments: readonly string[]): string | null {
  const id = segments[2];
  if (segments[1] !== 'issue' || id === undefined) return null;
  if (!/^[A-Za-z][A-Za-z0-9]*-[0-9]+$/.test(id)) return null;
  const slug = words(decode(segments[3]));
  return slug === null ? id.toUpperCase() : `${id.toUpperCase()} ${slug}`;
}

function githubRef(segments: readonly string[]): GitHubRef | null {
  const [owner, repo, kind, n] = segments;
  if (owner === undefined || repo === undefined || n === undefined) return null;
  if (kind !== 'pull' && kind !== 'issues') return null;
  if (!/^[0-9]+$/.test(n)) return null;
  const name = /^[A-Za-z0-9_.-]+$/;
  if (!name.test(owner) || !name.test(repo)) return null;
  return { owner, repo, number: Number(n), kind: kind === 'pull' ? 'pull' : 'issue' };
}

/**
 * The label a URL carries, or null for anything but an http(s) link to Notion,
 * Figma, Linear or GitHub. Never throws and never fetches.
 */
export function linkLabel(raw: string): LinkLabel | null {
  const url = raw.trim();
  const scheme = /^https?:\/\//i.exec(url);
  if (scheme === null) return null;
  const rest = url.slice(scheme[0].length);
  const authorityEnd = rest.search(/[/?#]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  const hostPort = /^([A-Za-z0-9.-]+)(?::[0-9]+)?$/.exec(authority);
  if (hostPort === null) return null;
  const host = hostPort[1]!.toLowerCase().replace(/\.$/, '');

  const after = authorityEnd === -1 ? '' : rest.slice(authorityEnd);
  const pathEnd = after.search(/[?#]/);
  const path = pathEnd === -1 ? after : after.slice(0, pathEnd);
  const segments = path.split('/').filter((s) => s !== '');

  const known = SERVICES.find(({ domains }) =>
    domains.some((d) => host === d || host.endsWith(`.${d}`)),
  );
  if (known === undefined) return null;

  let title: string | null = null;
  let github: GitHubRef | null = null;
  switch (known.service) {
    case 'notion':
      title = notionTitle(segments);
      break;
    case 'figma':
      title = figmaTitle(segments);
      break;
    case 'linear':
      title = linearTitle(segments);
      break;
    case 'github':
      github = githubRef(segments);
      title = github === null ? null : `${github.owner}/${github.repo}#${segments[3]}`;
      break;
  }
  return {
    service: known.service,
    serviceName: known.serviceName,
    title,
    text: title ?? known.serviceName,
    github,
  };
}
