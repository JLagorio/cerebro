import { clientToolsets, toolsetWrites } from '@/lib/policy/tools';
import { scopeAdmits } from './agentAccess';
import { rustTrim } from './comments';
import { isKnowledgePath } from './okf';

export interface ClientGrant {
  toolsets: string[];
  writeScope: string[];
  readScope: string[] | null;
}
export interface ClientTokenRequest extends ClientGrant {
  name: string;
}
export interface ClientToken extends ClientTokenRequest {
  tokenId: string;
  vaultId: string;
  vaultPath: string;
  slug: string;
  createdAt: string;
  lastUsedAt: string | null;
  currentVault: boolean;
}
export interface CreatedClientToken {
  token: ClientToken;
  secret: string;
}
export interface ClientAccessStatus {
  enabled: boolean;
  port: number;
  url: string | null;
  error: string | null;
}

export const CLIENT_TOKEN_CAP = 20;
export const CLIENT_CAP_WORDS = 'You have 20 tokens. Revoke one to make another.';
export const CLIENT_DUPLICATE =
  'This vault already has a token with that name. Choose another name.';
export const CLIENT_UNAVAILABLE =
  "Cerebro's runtime database isn't open, so tokens can't be read or made.";
export const CLIENT_PORT_WORDS = 'Choose a port from 1024 to 65535.';

const hasControls = (value: string): boolean =>
  Array.from(value).some((char) => {
    const n = char.codePointAt(0)!;
    return n <= 31 || (n >= 127 && n <= 159);
  });

/** The browser twin replays src-tauri/fixtures/client-tokens.json. */
export function clientName(raw: string): { name: string; slug: string } {
  const name = rustTrim(raw);
  if (!name || Array.from(name).length > 100)
    throw new Error('Give this token a name from 1 to 100 characters.');
  if (hasControls(name)) throw new Error("A token name can't contain control characters.");
  const slug =
    name
      .replace(/[A-Z]/g, (char) => char.toLowerCase())
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32)
      .replace(/-+$/g, '') || 'app';
  return { name, slug };
}

function utf8Bytes(value: string): number {
  return Array.from(value).reduce((n, char) => {
    const point = char.codePointAt(0)!;
    return n + (point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4);
  }, 0);
}

function folders(raw: readonly string[], axis: 'read' | 'write'): string[] {
  const normalized = raw.map((input) => {
    let folder = rustTrim(input);
    for (;;) {
      folder = folder.replace(/^\/+|\/+$/g, '');
      if (folder.startsWith('./')) folder = folder.slice(2);
      else break;
    }
    if (!folder || folder === '.')
      throw new Error(`Choose a ${axis} folder inside the vault, not the whole vault.`);
    if (utf8Bytes(folder) > 512) throw new Error(`A ${axis} folder must be at most 512 bytes.`);
    if (folder.includes('\\') || hasControls(folder))
      throw new Error(`A ${axis} folder can't contain a backslash or control characters.`);
    if (folder.split('/').some((part) => part.startsWith('.')))
      throw new Error(`A ${axis} folder can't contain a hidden or parent directory.`);
    folder = folder.replace(/\/+/g, '/');
    if (axis === 'write' && isKnowledgePath(`${folder}/`))
      throw new Error("A token can't write in Knowledge.");
    return folder;
  });
  const unique = [...new Set(normalized)];
  if (unique.length < 1 || unique.length > 20)
    throw new Error(`Choose from 1 to 20 ${axis} folders.`);
  return unique;
}

export function clientGrant(raw: ClientGrant): ClientGrant {
  const policy = clientToolsets();
  if (!raw.toolsets.includes(policy.default.id))
    throw new Error(`A token must include the "${policy.default.id}" toolset.`);
  const allowed = new Set([policy.default.id, ...policy.grantable.map((set) => set.id)]);
  const seen = new Set<string>();
  for (const id of raw.toolsets) {
    if (!allowed.has(id)) throw new Error(`A token can't hold the ${JSON.stringify(id)} toolset.`);
    if (seen.has(id)) throw new Error(`A token can't repeat the ${JSON.stringify(id)} toolset.`);
    seen.add(id);
  }
  return {
    toolsets: [...raw.toolsets],
    writeScope: raw.toolsets.some(toolsetWrites) ? folders(raw.writeScope, 'write') : [],
    readScope: raw.readScope === null ? null : folders(raw.readScope, 'read'),
  };
}

export function grantWords(grant: ClientGrant): string[] {
  const words = [
    grant.readScope === null ? 'Reads the whole vault' : `Reads ${grant.readScope.join(', ')}`,
  ];
  if (grant.toolsets.some(toolsetWrites)) words.push(`Writes ${grant.writeScope.join(', ')}`);
  const { grantable } = clientToolsets();
  for (const set of grantable)
    if (grant.toolsets.includes(set.id) && !toolsetWrites(set.id)) words.push(set.label);
  return words;
}

export function clientSnippets({ url, secret }: { url: string | null; secret?: string | null }): {
  claude: string;
  cursor: string;
} {
  const address = url && /^http:\/\/127\.0\.0\.1:\d{1,5}\/mcp$/.test(url) ? url : '<address>';
  const token = secret && /^cbr_[0-9a-f]{64}$/.test(secret) ? secret : '<your token>';
  return {
    claude: `claude mcp add --transport http cerebro-vault ${address} --header "Authorization: Bearer ${token}"`,
    cursor: JSON.stringify(
      {
        mcpServers: {
          'cerebro-vault': {
            type: 'http',
            url: address,
            headers: { Authorization: `Bearer ${token}` },
          },
        },
      },
      null,
      2,
    ),
  };
}

export interface ClientReach {
  token: ClientToken;
  read: boolean;
  write: boolean;
  reason: string;
}
export function clientReach(
  tokens: readonly ClientToken[],
  path: string,
  governed: boolean,
): ClientReach[] {
  return tokens
    .filter((token) => token.currentVault)
    .map((token) => {
      const writing = token.toolsets.some(toolsetWrites);
      const inside = scopeAdmits(token.writeScope, path);
      const protectedPage = governed || isKnowledgePath(path);
      return {
        token,
        read: scopeAdmits(token.readScope, path),
        write: writing && inside && !protectedPage,
        reason: !writing
          ? 'Its token only reads.'
          : protectedPage
            ? 'Tokens cannot change Agent pages, Type docs or Knowledge.'
            : `${inside ? 'Inside' : 'Outside'} its token's write scope: ${token.writeScope.join(', ')}.`,
      };
    });
}
