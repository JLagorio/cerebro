// @vitest-environment node
import { join } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { ESLint } from 'eslint';
import ts from 'typescript';
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
  it('admits the generated workspace types and no neighboring generated module', async () => {
    expect(
      await railMessages(
        'src/engine/probe.ts',
        "import type { SelectedRecordVersion } from '@/lib/generated/workspace'; export type V = SelectedRecordVersion;",
      ),
    ).toEqual([]);
    for (const path of ['@/lib/generated/private', '@/lib/generated/workspace/internal']) {
      expect(
        await railMessages('src/engine/probe.ts', `import type { V } from '${path}';`),
      ).toHaveLength(1);
    }
  });

  it('keeps the generated workspace leaf free of runtime code and imported dependencies', () => {
    const path = join(REPO, 'src/lib/generated/workspace.ts');
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest);
    expect(source.statements.length).toBeGreaterThan(0);
    for (const statement of source.statements) {
      expect(ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)).toBe(
        true,
      );
    }
  });
  it('admits only the pure consumer-domain data leaf', async () => {
    expect(
      await railMessages(
        'src/engine/probe.ts',
        "export { isConsumerDomain } from '@/lib/consumerDomains';",
      ),
    ).toEqual([]);
    expect(
      await railMessages('src/engine/probe.ts', "export { default } from 'free-email-domains';"),
    ).toHaveLength(1);
  });
  it('admits the shared pure structural equality leaf', async () => {
    expect(
      await railMessages('src/engine/probe.ts', "export { deepEqual } from '@/lib/deepEqual';"),
    ).toEqual([]);
  });
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
    ['an rrule subpath', "import 'rrule/dist/esm/index';"],
    ['a yaml subpath', "import 'yaml/util';"],
    ['a URL parser internal subpath', "import 'whatwg-url/lib/URL';"],
    ['shared/policy code rather than a table', "import '../../shared/policy/table.ts';"],
    ['shared/schema code rather than a table', "import '../../shared/schema/kinds.ts';"],
    ['a shared/calendar file that is not JSON', "import '../../shared/calendar/README.md';"],
    ['a shared/import file that is not JSON', "import '../../shared/import/README.md';"],
    ['a shared/files file that is not JSON', "import '../../shared/files/README.md';"],
    [
      'shared JSON outside the four table folders',
      "import '../../shared/prompt/retired-terms.json';",
    ],
  ])('fails %s', async (_label, code) => {
    expect(await railMessages(ENGINE, code)).toHaveLength(1);
  });

  it('passes every allowlisted import, static, dynamic and type-only', async () => {
    const code = [
      "import './types';",
      "import type { Entry } from '@/engine/types';",
      "import 'yaml';",
      "import 'rrule';",
      "import 'whatwg-url';",
      "import '@/lib/slug';",
      "import '@/lib/templates';",
      "import '@/lib/sha256';",
      "import '@/lib/policy/table';",
      "import '@/lib/policy/tools';",
      "import '@/lib/policy/toolApproval';",
      "import '@/views/viewKinds';",
      "import '../../shared/policy/staleness.v1.json';",
      "import '../../shared/schema/field-kinds.v1.json';",
      "import '../../shared/calendar/dates.v1.json';",
      "import '../../shared/files/kinds.v1.json';",
      "import '../../shared/import/sources.v1.json';",
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

  it('holds src/engine/ai/ to the same rail, its siblings by ./ and the engine by alias (M91.10)', async () => {
    const AI = 'src/engine/ai/probe.ts';
    for (const code of [
      "import type { ToolCall } from '@/agent/types';",
      "import { readCliTranscript } from '@/lib/ipc';",
      "import { Trace } from '@/components/ai/Trace';",
      "import type { RunChangeset } from '../changeset';",
    ])
      expect(await railMessages(AI, code), code).toEqual([
        expect.stringContaining('engine/ is the pure core'),
      ]);
    const allowed = [
      "import './types';",
      "import type { ChangeKind } from '@/engine/changeset';",
      "import { parseURL } from 'whatwg-url';",
      'export const p = parseURL;',
    ].join('\n');
    expect(await railMessages(AI, allowed)).toEqual([]);
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
 * here as a probe that passed. Each rail is told apart by its own message:
 * in engine/ a Tauri import breaks the allowlist too, and draws both.
 */
describe('each file class keeps every rail but its own exemption', () => {
  type Rail =
    'pdfjs' | 'tauri' | 'mermaid' | 'ironcalc' | 'mockParse' | 'comments' | 'engine' | 'select';
  const MARK: Record<Rail, string> = {
    pdfjs: 'load pdfjs-dist',
    tauri: 'Tauri loads only in the IPC adapters',
    mermaid: 'load mermaid',
    ironcalc: 'load @ironcalc/wasm',
    mockParse: 'reads mockParse',
    comments: "loads '@blocknote/core/comments'",
    engine: 'engine/ is the pure core',
    select: 'No native <select>',
  };
  const PROBES: Record<Rail, string[]> = {
    pdfjs: [
      "import 'pdfjs-dist';",
      "export const p = () => import('pdfjs-dist/legacy/build/pdf.mjs');",
      "export type P = typeof import('pdfjs-dist');",
    ],
    tauri: [
      "import { invoke } from '@tauri-apps/api/core';\nexport const i = invoke;",
      "export const l = () => import('@tauri-apps/api/event');",
    ],
    mermaid: [
      "import mermaid from 'mermaid';\nexport const m = mermaid;",
      "export const e = () => import('@mermaid-js/layout-elk');",
    ],
    ironcalc: [
      "import { Model } from '@ironcalc/wasm'; export const m = Model;",
      "export const m = () => import('@ironcalc/wasm');",
      "import type { Model } from '@ironcalc/wasm'; export type M = Model;",
      "export type M = typeof import('@ironcalc/wasm');",
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
    select: [
      "export const s = document.createElement('select');",
      "export const s = React.createElement('select', null);",
    ],
  };
  const CLASSES: [path: string, allowed: Rail[]][] = [
    ['src/workspace/viewers/pdf/pdfjs.ts', ['pdfjs', 'engine']],
    ['src/workspace/viewers/pdf/probe.pdf.test.ts', ['pdfjs', 'engine']],
    ['src/pages/Probe.tsx', ['engine']],
    ['src/lib/ipc.ts', ['tauri', 'engine']],
    ['src/lib/gitIpc.ts', ['tauri', 'engine']],
    ['src/lib/rootsIpc.ts', ['tauri', 'engine']],
    ['src/agent/agentIpc.ts', ['tauri', 'engine']],
    ['src/mermaid/render.ts', ['mermaid', 'engine']],
    ['src/mermaid/flowchart/probe.mermaid.test.ts', ['mermaid', 'engine']],
    ['src/lib/mockIpc.ts', ['mockParse', 'engine']],
    ['src/lib/mockSheet.ts', ['ironcalc', 'engine']],
    ['src/lib/mockSheet.ironcalc.test.ts', ['ironcalc', 'engine']],
    ['src/lib/mockParse.test.ts', ['mockParse', 'engine']],
    ['src/lib/scanGolden.test.ts', ['mockParse', 'engine']],
    ['src/engine/probe.ts', []],
    ['src/engine/probe.test.ts', ['engine']],
    ['src/editor/commentSpike.test.ts', ['comments', 'engine']],
    ['src/editor/Probe.test.tsx', ['engine']],
    ['src/components/FileImage.tsx', ['engine']],
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

it('only the reminder hook posts native notifications and no web notification remains', () => {
  const walk = (dir: string): string[] =>
    readdirSync(join(REPO, dir), { withFileTypes: true }).flatMap((entry): string[] => {
      const path = `${dir}/${entry.name}`;
      return entry.isDirectory()
        ? walk(path)
        : /\.tsx?$/.test(path) && !/\.test\./.test(path)
          ? [path]
          : [];
    });
  const callers: string[] = [];
  for (const path of walk('src')) {
    const text = readFileSync(join(REPO, path), 'utf8');
    expect(text, path).not.toMatch(/new\s+Notification\s*\(|Notification\.requestPermission/);
    if (
      !['src/lib/ipc.ts', 'src/lib/mockIpc.ts'].includes(path) &&
      /\bpostNotification\s*\(/.test(text)
    )
      callers.push(path);
  }
  expect(callers).toEqual(['src/hooks/useReminders.ts']);
});

it('only mockSheet.ts and *.ironcalc.test.ts load the sheet wasm', async () => {
  expect(await railMessages('src/lib/mockSheet.ts', "import '@ironcalc/wasm';")).toEqual([]);
  expect(await railMessages('src/lib/probe.ironcalc.test.ts', "import '@ironcalc/wasm';")).toEqual(
    [],
  );
  expect(
    await railMessages('src/lib/mockSheet.ts', "import './sheetValues/values.wasm?url';"),
  ).toEqual([]);
  for (const code of [
    "import '@ironcalc/wasm';",
    "export const m = () => import('@ironcalc/wasm');",
    "import type { Model } from '@ironcalc/wasm'; export type M = Model;",
    "import '@/lib/sheetValues/values.wasm?url';",
    "export const m = () => import('../lib/sheetValues/values.wasm?url');",
  ]) {
    expect(
      (await railMessages('src/sheet/Probe.tsx', code)).some((message) =>
        message.includes('load @ironcalc/wasm'),
      ),
    ).toBe(true);
  }
});

describe('only the pdf loader and *.pdf.test.ts load pdfjs-dist', () => {
  it('refuses a component import and explains the loader boundary', async () => {
    expect(
      (
        await railMessages('src/pages/Probe.tsx', "import 'pdfjs-dist/legacy/web/pdf_viewer.mjs';")
      )[0],
    ).toContain('PDF loader');
  });
});

describe('only the image components draw <img>', () => {
  const code = 'export const Picture = () => <img src="https://images.example/a.png" alt="a" />;';
  it.each([
    'src/pages/Probe.tsx',
    'src/detail/Probe.tsx',
    'src/editor/Probe.tsx',
    'src/components/Probe.tsx',
    'src/engine/Probe.tsx',
  ])('refuses a raw image in %s', async (path) => {
    expect(await railMessages(path, code)).toEqual([expect.stringContaining('Only FileImage')]);
  });
  it.each([
    'src/components/FileImage.tsx',
    'src/components/FileThumb.tsx',
    'src/components/RemoteImage.tsx',
    'src/components/ui/Avatar.tsx',
  ])('allows the reviewed boundary %s', async (path) => {
    expect(await railMessages(path, code)).toEqual([]);
  });
});

/**
 * CV-63: every select is the design system's `Select` (or `Dropdown`, which
 * renders it), and the rail has no exemption. Third-party UI that builds a
 * native one is wrapped where it is wired in, as BlockNote's code block is.
 */
describe('no native select draws anywhere', () => {
  const selectMessages = async (path: string, code: string) =>
    (await railMessages(path, code)).filter((m) => m.includes('No native <select>'));

  it.each([
    'src/pages/Probe.tsx',
    'src/editor/Probe.tsx',
    'src/components/ui/Probe.tsx',
    'src/engine/Probe.tsx',
    'src/components/FileImage.tsx',
    'src/pages/Probe.test.tsx',
  ])('refuses a JSX select in %s, and names the fix', async (path) => {
    expect(
      await selectMessages(path, 'export const Pick = () => <select aria-label="Pick" />;'),
    ).toEqual([expect.stringContaining("'@/components/ui/Select'")]);
  });

  it.each([
    "document.createElement('select')",
    "host.ownerDocument.createElement('SELECT')",
    "React.createElement('select', null)",
    "createElement('select')",
  ])('refuses a select built by %s', async (call) => {
    expect(
      await selectMessages('src/editor/probe.ts', `export const s = () => ${call};`),
    ).toHaveLength(1);
  });

  it.each([
    'export const P = () => <Select options={[]} value="" onChange={() => {}} />;',
    "export const q = (el: Element) => el.querySelector('select');",
    'export const t = (el: unknown) => el instanceof HTMLSelectElement;',
    "export const o = () => document.createElement('option');",
    '// A native <select> named in a comment.\nexport const c = 1;',
  ])('passes %s', async (code) => {
    expect(await selectMessages('src/pages/Probe.tsx', code)).toEqual([]);
  });

  it('needs no exemption for the design system Select or the code block that wraps one', async () => {
    for (const path of ['src/components/ui/Select.tsx', 'src/editor/codeBlock.tsx']) {
      expect(await selectMessages(path, readFileSync(join(REPO, path), 'utf8')), path).toEqual([]);
    }
  });
});
