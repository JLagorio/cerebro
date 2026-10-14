// The one forbidden-pattern list (M56.1). The repo is public, and every file
// under src-tauri/fixtures/cli-stream/ has the shape of a Claude Code run, so
// nothing written there may carry what a raw recording does: a user path, an
// address, a credential or a real id. The reducer (and the sanitizer after
// it) writes nothing when `scan` finds a hit, and scripts/fixtures.test.ts
// runs the same list over every fixture in CI. A new pattern goes here, once.

/** The synthetic ids fixtures use instead of real ones. */
export const SYNTHETIC_UUID = /^00000000-0000-4000-8000-[0-9a-f]{12}$/i;
export const SYNTHETIC_ID = /^(?:msg|toolu|srvtoolu|req)_0{8,}[0-9a-f]*$/;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const PREFIXED_ID = /\b(?:msg|toolu|srvtoolu|req)_[A-Za-z0-9]+/g;

function matches(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[0]);
}

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
  { what: 'a bearer token', find: (text) => matches(text, /Bearer\s+\S+/g) },
];

/** Every hit in `text`, each as "what: what matched". Empty means clean. */
export function scan(text: string): string[] {
  return FORBIDDEN.flatMap(({ what, find }) => find(text).map((hit) => `${what}: ${hit}`));
}
