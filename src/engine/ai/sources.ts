/**
 * The sources a reply drew on (M91.10): what the Sources element lists. Pure:
 * no DOM.
 *
 * Gathered in the order the turn met them: web search results, pages the run
 * fetched, vault pages a call read, and the http(s) links in the reply's own
 * text. A source met twice is listed once, where it was first met, with the
 * first title anyone gave it. Only an http(s) URL is ever a `url` source; a
 * vault page is its vault-relative path, opened in the app and never through
 * an href (CV-16). The conversation's list (M92.3) merges the replies' lists
 * by the same key.
 */

import { parseURL } from 'whatwg-url';
import type { SourceRef, SourceVia, ToolResultData } from './types';

/** One thing a turn met, in order. */
export type SourceInput =
  /** A call's result: a web search's results and a fetched page count. */
  | { from: 'result'; data: ToolResultData }
  /** A vault page a call read, by its vault-relative path. */
  | { from: 'read'; path: string; title?: string }
  /** The reply's own markdown. */
  | { from: 'text'; text: string };

export function collectSources(inputs: readonly SourceInput[]): SourceRef[] {
  const sources = new Map<string, SourceRef>();
  const add = (source: SourceRef, title: string | undefined) => {
    const named = title?.trim() || undefined;
    const key = sourceKey(source);
    const seen = sources.get(key);
    if (seen === undefined)
      sources.set(key, named === undefined ? source : { ...source, title: named });
    else if (seen.title === undefined && named !== undefined) seen.title = named;
  };
  const addUrl = (raw: string, via: SourceVia, title?: string) => {
    const url = httpUrl(raw);
    if (url !== null) add({ kind: 'url', url, via }, title);
  };
  for (const input of inputs) {
    if (input.from === 'read') {
      const path = vaultPath(input.path);
      if (path !== null) add({ kind: 'vault', path, via: 'read' }, input.title);
    } else if (input.from === 'text') {
      for (const link of linksIn(input.text)) addUrl(link.url, 'text', link.title);
    } else if (input.data.type === 'web_search') {
      for (const result of input.data.results) addUrl(result.url, 'search', result.title);
    } else if (input.data.type === 'web_fetch') {
      // A fetch that ended on an HTTP error brought back no page to draw on.
      const failed = input.data.code !== undefined && input.data.code >= 400;
      if (!failed) addUrl(input.data.url, 'fetch');
    }
  }
  return [...sources.values()];
}

/** What makes two sources one: a URL by `urlKey`, a vault page by its
 * path. A reply's list and the conversation's dedupe by it alike. */
export function sourceKey(source: SourceRef): string {
  return source.kind === 'url' ? `url:${urlKey(source.url)}` : `path:${source.path}`;
}

/** A source the conversation drew on, and the latest reply that did. */
export interface CitedSource {
  source: SourceRef;
  /** That reply's id: where the source's row jumps. */
  turn: string;
}

/**
 * The conversation's sources (M92.3), for the rail's Sources card: each
 * reply's own list merged, most recent first. `turns` come oldest first, as
 * the conversation holds them; the latest reply's sources lead, in that
 * reply's own order, then each earlier reply's. A source more than one reply
 * drew on is listed once, under the latest of them, by `sourceKey`, with the
 * title that reply gave it, else the latest title an earlier one gave. The
 * replies' lists are never written to.
 */
export function mergeSources(
  turns: readonly { turn: string; sources: readonly SourceRef[] }[],
): CitedSource[] {
  const merged = new Map<string, CitedSource>();
  for (let i = turns.length - 1; i >= 0; i--) {
    const { turn, sources } = turns[i];
    for (const source of sources) {
      const key = sourceKey(source);
      const seen = merged.get(key);
      if (seen === undefined) merged.set(key, { source, turn });
      else if (seen.source.title === undefined && source.title !== undefined)
        seen.source = { ...seen.source, title: source.title };
    }
  }
  return [...merged.values()];
}

/** `raw` as an http(s) URL with a host and no credentials, trimmed; null for
 * anything else, which no element may link (CV-16). A control character is
 * refused too: the URL parser drops tabs and newlines silently, so the link
 * would go somewhere other than the text it shows. */
export function httpUrl(raw: string): string | null {
  const text = raw.trim();
  // eslint-disable-next-line no-control-regex -- C0 controls and DEL are the match.
  if (!/^https?:\/\//i.test(text) || /[\u0000-\u001f\u007f]/.test(text)) return null;
  const url = parseURL(text);
  if (url === null || (url.scheme !== 'http' && url.scheme !== 'https')) return null;
  if (url.host === null || url.host === '' || url.username !== '' || url.password !== '')
    return null;
  return text;
}

/** What makes two URLs one source: case-blind scheme and host, no fragment,
 * an empty path the same as "/". */
function urlKey(url: string): string {
  const m = /^(https?):\/\/([^/?#]*)([^#]*)/i.exec(url);
  if (m === null) return url;
  return `${m[1].toLowerCase()}://${m[2].toLowerCase()}${m[3] === '/' ? '' : m[3]}`;
}

/** A vault-relative page path, or null for one that is absolute, a URL, or
 * climbs out of the vault. */
function vaultPath(raw: string): string | null {
  const path = raw.trim().replace(/^\.\//, '');
  if (path === '' || /^[a-z][a-z\d+.-]*:|^[/\\~]|\\/i.test(path)) return null;
  const segments = path.split('/');
  return segments.some((segment) => segment === '' || segment === '.' || segment === '..')
    ? null
    : path;
}

/** `text` with fenced blocks and code spans blanked: a URL in code is an
 * example, not a source. */
function withoutCode(text: string): string {
  let fence: string | null = null;
  return text
    .split('\n')
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fence !== null) {
        if (marker !== null && marker[1][0] === fence[0] && marker[1].length >= fence.length)
          fence = null;
        return '';
      }
      if (marker !== null) {
        fence = marker[1];
        return '';
      }
      return line.replace(/(`+)[\s\S]*?\1/g, ' ');
    })
    .join('\n');
}

const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/** A bare URL without the punctuation of the sentence around it. A closing
 * bracket stays when the URL itself opened it, as in `/wiki/Foo_(bar)`. */
function trimTrailing(url: string): string {
  let end = url.length;
  while (end > 0) {
    const last = url[end - 1];
    const opener = CLOSERS[last] as string | undefined;
    if (opener !== undefined) {
      const body = url.slice(0, end);
      if (body.split(opener).length >= body.split(last).length) break;
      end -= 1;
    } else if (/[.,;:!?*_~]/.test(last)) end -= 1;
    else break;
  }
  return url.slice(0, end);
}

/** A markdown link's destination, read from just after its `](`: the URL
 * and where the link ends, or null when it is no http(s) link. */
function linkTarget(text: string, at: number): { url: string; end: number } | null {
  let i = at;
  while (text[i] === ' ') i += 1;
  let url: string;
  if (text[i] === '<') {
    const close = text.indexOf('>', i);
    if (close === -1) return null;
    url = text.slice(i + 1, close);
    i = close + 1;
  } else {
    const start = i;
    let depth = 0;
    for (; i < text.length && !/\s/.test(text[i]); i += 1) {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')') {
        if (depth === 0) break;
        depth -= 1;
      }
    }
    url = text.slice(start, i);
  }
  const close = /^\s*(?:"[^"]*"|'[^']*'|\([^)]*\))?\s*\)/.exec(text.slice(i));
  if (close === null || !/^https?:\/\//i.test(url)) return null;
  return { url, end: i + close[0].length };
}

/** The http(s) links in markdown `text`, in order, outside code. A link's
 * label is its title; an image is no source. */
function linksIn(text: string): { url: string; title?: string }[] {
  const prose = withoutCode(text);
  const links: { url: string; title?: string }[] = [];
  const pattern = /\[([^\]\n]*)\]\(|<(https?:\/\/[^\s<>]+)>|\bhttps?:\/\/[^\s<>"'`]+/gi;
  for (let m = pattern.exec(prose); m !== null; m = pattern.exec(prose)) {
    if (m[1] !== undefined) {
      const target = linkTarget(prose, pattern.lastIndex);
      if (target === null) continue;
      pattern.lastIndex = target.end;
      if (m.index > 0 && prose[m.index - 1] === '!') continue;
      const label = m[1].trim();
      links.push(
        label === '' || label === target.url
          ? { url: target.url }
          : { url: target.url, title: label },
      );
    } else if (m[2] !== undefined) {
      links.push({ url: m[2] });
    } else {
      links.push({ url: trimTrailing(m[0]) });
    }
  }
  return links;
}
