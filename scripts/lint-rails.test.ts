// @vitest-environment node
import { join } from 'node:path';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The import rails in eslint.config.js (M53.20), proven on virtual files: the
 * real config lints a snippet as if it lived at a path, so every rail and
 * every exemption is checked where it applies. Flat config replaces a rule's
 * options in each matching object instead of merging them, so a file class
 * that forgets to compose a rail drops it without a word; the matrix below is
 * what notices.
 */

const REPO = join(__dirname, '..');
const RAIL_RULES = new Set(['no-restricted-imports', 'no-restricted-syntax']);

let eslint: ESLint;

beforeAll(async () => {
  eslint = new ESLint({ cwd: REPO });
  // The first lint loads the config and its plugins; pay for it here.
  await eslint.lintText('', { filePath: join(REPO, 'src/engine/warmup.ts') });
}, 60_000);

/** The rail messages `code` draws at `path`. A snippet that does not parse
 * would draw none and pass every "allowed" case, so it fails instead. */
async function railMessages(path: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(REPO, path) });
  const fatal = result.messages.find((m) => m.fatal);
  if (fatal !== undefined) throw new Error(`${path} did not parse: ${fatal.message}`);
  return result.messages
    .filter((m) => m.ruleId !== null && RAIL_RULES.has(m.ruleId))
    .map((m) => m.message);
}

describe('the roadmap acceptance cases', () => {
  it('fails an engine import from a store', async () => {
    const messages = await railMessages(
      'src/engine/probe.ts',
      "import { useVaultStore } from '@/stores/vaultStore';\nexport const s = useVaultStore;\n",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('engine/ is the pure core');
  });

  it('fails a dynamic @tauri-apps import outside the adapters', async () => {
    const messages = await railMessages(
      'src/pages/Probe.tsx',
      "export const load = () => import('@tauri-apps/api/core');\n",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('src/lib/ipc.ts');
  });
});

describe('engine/ imports only its allowlist', () => {
  const ENGINE = 'src/engine/probe.ts';

  it.each([
    ['a type-only import from agent/', "import type { RunRecord } from '@/agent/runs';"],
    ['a re-export from a store', "export { useVaultStore } from '@/stores/vaultStore';"],
    ['a dynamic import of a store', "export const s = () => import('@/stores/vaultStore');"],
    ['a type that names a store', "export type S = typeof import('@/stores/vaultStore');"],
    ['an engine path in the wrong case', "import '@/Engine/types';"],
    ['a parent-folder import', "import '../lib/mockIpc';"],
    ['a lib module off the list', "import '@/lib/slugger';"],
    ['a policy module off the list', "import '@/lib/policy/verdict';"],
    ['a yaml subpath', "import 'yaml/util';"],
    ['shared/policy code rather than a table', "import '../../shared/policy/table.ts';"],
  ])('fails %s', async (_label, code) => {
    expect(await railMessages(ENGINE, code)).toHaveLength(1);
  });

  it('passes every allowlisted import, static, dynamic and type-only', async () => {
    const code = [
      "import './types';",
      "import type { Entry } from '@/engine/types';",
      "import 'yaml';",
      "import '@/lib/slug';",
      "import '@/lib/templates';",
      "import '@/lib/sha256';",
      "import '@/lib/policy/table';",
      "import '@/lib/policy/tools';",
      "import '@/lib/policy/toolApproval';",
      "import '@/views/viewKinds';",
      "import '../../shared/policy/staleness.v1.json';",
      "export const t = () => import('./types');",
      "export type V = typeof import('@/views/viewKinds');",
      'export type E = Entry;',
    ].join('\n');
    expect(await railMessages(ENGINE, code)).toEqual([]);
  });

  it('lets an engine test import a store', async () => {
    expect(await railMessages('src/engine/probe.test.ts', "import '@/stores/vaultStore';")).toEqual(
      [],
    );
  });
});

describe('engine imports admit the two scene libraries and no subpath', () => {
  const ENGINE = 'src/engine/x.ts';

  it.each([
    "import { getStroke } from 'perfect-freehand';\nexport const g = getStroke;",
    "import { generateKeyBetween } from 'fractional-indexing';\nexport const k = generateKeyBetween;",
  ])('passes %s', async (code) => {
    expect(await railMessages(ENGINE, code)).toEqual([]);
  });

  it.each([
    "import 'perfect-freehand/dist/esm/index.mjs';",
    "import 'fractional-indexing/src/index.js';",
    "export const p = () => import('perfect-freehand/dist/cjs/index.js');",
  ])('fails %s', async (code) => {
    const messages = await railMessages(ENGINE, code);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('perfect-freehand and fractional-indexing');
  });
});

describe('only render.ts and *.mermaid.test.ts load mermaid', () => {
  it('fails a plain test that imports mermaid, and names the fix', async () => {
    const messages = await railMessages('src/pages/Probe.test.tsx', "import 'mermaid';");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("mock '@/mermaid/render'");
  });

  it('passes the renderer and a measuring test', async () => {
    expect(
      await railMessages('src/mermaid/render.ts', "export const m = () => import('mermaid');"),
    ).toEqual([]);
    expect(await railMessages('src/mermaid/probe.mermaid.test.ts', "import 'mermaid';")).toEqual(
      [],
    );
  });

  it('reads a vi.mock of mermaid as a call, not an import', async () => {
    expect(
      await railMessages('src/pages/Probe.test.tsx', "vi.mock('mermaid', () => ({}));"),
    ).toEqual([]);
  });
});

describe("only the M70.1 spike loads '@blocknote/core/comments'", () => {
  it('fails a production file that imports it, and names the fix', async () => {
    const messages = await railMessages(
      'src/editor/Probe.tsx',
      "import { CommentsExtension } from '@blocknote/core/comments';\nexport const c = CommentsExtension;\n",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('CommentHighlights');
  });

  it('fails a dynamic import and a re-export too', async () => {
    expect(
      await railMessages(
        'src/editor/Probe.tsx',
        "export const c = () => import('@blocknote/core/comments');",
      ),
    ).toHaveLength(1);
    expect(
      await railMessages('src/editor/probe.ts', "export * from '@blocknote/core/comments';"),
    ).toHaveLength(1);
  });

  it('passes the spike test, and leaves the rest of @blocknote/core alone', async () => {
    expect(
      await railMessages(
        'src/editor/commentSpike.test.ts',
        "import { CommentsExtension } from '@blocknote/core/comments';\nexport const c = CommentsExtension;\n",
      ),
    ).toEqual([]);
    expect(
      await railMessages(
        'src/editor/Probe.tsx',
        "import { createExtension } from '@blocknote/core';\nimport '@blocknote/core/extensions';\nexport const c = createExtension;\n",
      ),
    ).toEqual([]);
  });
});

describe('only mockIpc reads mockParse', () => {
  it('fails any other importer, and names the fix', async () => {
    const messages = await railMessages('src/pages/Probe.tsx', "import '@/lib/mockParse';");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('@/engine/frontmatter');
  });

  it('passes the mock backend', async () => {
    expect(await railMessages('src/lib/mockIpc.ts', "import './mockParse';")).toEqual([]);
  });
});

/**
 * Every file class against every rail. A class keeps every rail but its own
 * exemption, so a class that dropped a rail by composing too few shows up
 * here as an import that passed. Each rail is told apart by its own message:
 * in engine/ a Tauri import breaks the allowlist too, and draws both.
 */
describe('each file class keeps every rail but its own exemption', () => {
  type Rail = 'tauri' | 'mermaid' | 'mockParse' | 'comments' | 'engine';
  const MARK: Record<Rail, string> = {
    tauri: 'Tauri loads only in the IPC adapters',
    mermaid: 'load mermaid',
    mockParse: 'reads mockParse',
    comments: "loads '@blocknote/core/comments'",
    engine: 'engine/ is the pure core',
  };
  const PROBES: Record<Rail, string[]> = {
    tauri: [
      "import { invoke } from '@tauri-apps/api/core';\nexport const i = invoke;",
      "export const l = () => import('@tauri-apps/api/event');",
    ],
    mermaid: [
      "import mermaid from 'mermaid';\nexport const m = mermaid;",
      "export const e = () => import('@mermaid-js/layout-elk');",
    ],
    mockParse: [
      "import { parseNote } from '@/lib/mockParse';\nexport const p = parseNote;",
      "export const p = () => import('./mockParse');",
    ],
    comments: [
      "import { CommentMark } from '@blocknote/core/comments';\nexport const m = CommentMark;",
      "export const c = () => import('@blocknote/core/comments');",
    ],
    engine: ["import { useUiStore } from '@/stores/uiStore';\nexport const u = useUiStore;"],
  };
  const CLASSES: [path: string, allowed: Rail[]][] = [
    ['src/pages/Probe.tsx', ['engine']],
    ['src/lib/ipc.ts', ['tauri', 'engine']],
    ['src/lib/gitIpc.ts', ['tauri', 'engine']],
    ['src/lib/rootsIpc.ts', ['tauri', 'engine']],
    ['src/agent/agentIpc.ts', ['tauri', 'engine']],
    ['src/mermaid/render.ts', ['mermaid', 'engine']],
    ['src/mermaid/flowchart/probe.mermaid.test.ts', ['mermaid', 'engine']],
    ['src/lib/mockIpc.ts', ['mockParse', 'engine']],
    ['src/lib/mockParse.test.ts', ['mockParse', 'engine']],
    ['src/lib/scanGolden.test.ts', ['mockParse', 'engine']],
    ['src/engine/probe.ts', []],
    ['src/engine/probe.test.ts', ['engine']],
    ['src/editor/commentSpike.test.ts', ['comments', 'engine']],
    ['src/editor/Probe.test.tsx', ['engine']],
  ];
  const cases = CLASSES.flatMap(([path, allowed]) =>
    (Object.keys(PROBES) as Rail[]).flatMap((rail) =>
      PROBES[rail].map((code) => [path, rail, allowed.includes(rail), code] as const),
    ),
  );

  it.each(cases)('%s, %s rail: allowed %s', async (path, rail, allowed, code) => {
    const messages = await railMessages(path, code);
    expect(messages.some((m) => m.includes(MARK[rail]))).toBe(!allowed);
  });
});
