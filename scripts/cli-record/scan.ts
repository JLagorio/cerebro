// The one forbidden-pattern list (M56.1). The repo is public, and every file
// under src-tauri/fixtures/cli-stream/ has the shape of a Claude Code run, so
// nothing written there may carry what a raw recording does: a user path, an
// address, a credential or a real id. The reducer and the sanitizer (M56.2)
// write nothing when `scan` finds a hit, and scripts/fixtures.test.ts runs the
// same list over every fixture in CI. A new pattern goes here, once.
//
// The secret shapes (M56.2) are also what the sanitizer replaces: SECRETS
// names each with the `kind` its stand-in carries, `redacted-<kind>-<n>`,
// which no pattern here matches.

/** The synthetic ids fixtures use instead of real ones. */
export const SYNTHETIC_UUID = /^00000000-0000-4000-8000-[0-9a-f]{12}$/i;
export const SYNTHETIC_ID = /^(?:msg|toolu|srvtoolu|req)_0{8,}[0-9a-f]*$/;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const PREFIXED_ID = /\b(?:msg|toolu|srvtoolu|req)_[A-Za-z0-9]+/g;

function matches(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[0]);
}

/** One credential shape: what it is, the stand-in's kind, and how to find it. */
export interface Secret {
  what: string;
  kind: string;
  pattern: RegExp;
}

/**
 * The credential shapes a recording could carry, most specific first, so an
 * Anthropic key is named as one before the general `sk-` shape sees it. Each
 * pattern is global, for replacing every occurrence.
 */
export const SECRETS: readonly Secret[] = [
  {
    what: 'a PEM private key',
    kind: 'pem',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)?/g,
  },
  { what: 'an Anthropic OAuth token', kind: 'oauth', pattern: /\bsk-ant-o[ar]t\d*-[\w-]{8,}/g },
  { what: 'an Anthropic API key', kind: 'anthropic', pattern: /\bsk-ant-[\w-]{8,}/g },
  { what: 'an sk- API key', kind: 'api-key', pattern: /\bsk-[\w-]{20,}/g },
  {
    what: 'a GitHub token',
    kind: 'github',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})/g,
  },
  { what: 'a Slack token', kind: 'slack', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { what: 'an AWS access key', kind: 'aws', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { what: 'a Google API key', kind: 'google', pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  {
    what: 'a JSON web token',
    kind: 'jwt',
    pattern: /\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}/g,
  },
  {
    what: 'credentials in a URL',
    kind: 'url-credentials',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"]+:[^\s/@"]+@/gi,
  },
  { what: 'a bearer token', kind: 'bearer', pattern: /Bearer\s+\S+/g },
  {
    what: "an MCP bearer (mcp.rs's 32 lowercase letters)",
    kind: 'mcp-bearer',
    pattern: /(?<![A-Za-z0-9])[a-z]{32}(?![A-Za-z0-9])/g,
  },
];

export interface Forbidden {
  what: string;
  find(text: string): string[];
}

/** What a raw recording carries, each with how to find it. */
export const FORBIDDEN: readonly Forbidden[] = [
  { what: 'a macOS home path', find: (text) => matches(text, /\/Users\//g) },
  { what: 'a Linux home path', find: (text) => matches(text, /\/home\//g) },
  { what: 'a macOS temporary folder', find: (text) => matches(text, /\/var\/folders\//g) },
  { what: "macOS's private /var", find: (text) => matches(text, /\/private\/var\//g) },
  { what: 'an email or other @-address', find: (text) => matches(text, /\S*@\S*/g) },
  {
    what: 'a real UUID',
    find: (text) => matches(text, UUID).filter((id) => !SYNTHETIC_UUID.test(id)),
  },
  {
    what: 'a real message, tool or request id',
    find: (text) => matches(text, PREFIXED_ID).filter((id) => !SYNTHETIC_ID.test(id)),
  },
  ...SECRETS.map(({ what, pattern }) => ({ what, find: (text: string) => matches(text, pattern) })),
];

/** Every hit in `text`, each as "what: what matched". Empty means clean. */
export function scan(text: string): string[] {
  return FORBIDDEN.flatMap(({ what, find }) => find(text).map((hit) => `${what}: ${hit}`));
}
