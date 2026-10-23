import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

// Rails (M53.20). An import rail bans one kind of import: static imports,
// re-exports and `import type` through no-restricted-imports, `import()`
// through no-restricted-syntax. An element rail bans one native element
// through no-restricted-syntax: `<img>` outside the image components (CV-61)
// and `<select>` everywhere (CV-63). Flat config REPLACES a rule's options in
// each matching object instead of merging them, so every file class at the
// bottom of this file composes the full set of rails it keeps: a class that
// named only its own exemption would silently drop every other rail.
// scripts/lint-rails.test.ts proves each rail and each exemption.

/** The only files that may load `@tauri-apps/*`. */
const ADAPTERS = [
  'src/lib/ipc.ts',
  'src/lib/gitIpc.ts',
  'src/lib/rootsIpc.ts',
  'src/agent/agentIpc.ts',
];

/** What engine/ may import, as one negative lookahead: anything else fails. */
const ENGINE_IMPORTS = new RegExp(
  `^(?!${[
    '\\./',
    '@/engine/',
    'yaml$',
    // M61.10: checked recurrence options in engine/recurrence.ts alone.
    'rrule$',
    // Pure leaves: no DOM, no store, no IPC. tsconfig.engine.json typechecks
    // them through these imports, which is the only check that reaches them.
    '@/lib/(?:consumerDomains|deepEqual|slug|templates|sha256|policy/(?:table|tools|toolApproval))$',
    // viewTab.ts's one edge into views, deliberate: capability data over
    // engine types with no React in it (its comment says why).
    '@/views/viewKinds$',
    // Tables the backends share: okf.ts reads staleness, M60.3's readers the
    // field kinds (shared/schema) and the date grammar (shared/calendar), and
    // fileKinds.ts the file kinds (shared/files, M66.1).
    '\\.\\./\\.\\./shared/(?:policy|schema|calendar|files|import)/[\\w.-]+\\.json$',
    // JSON Canvas's shared format; the scene boundary pins its one reader.
    '\\.\\./\\.\\./\\.\\./shared/canvas/[\\w.-]+\\.json$',
    // The whiteboard scene core's two pinned upstream libraries (M68.1), bare
    // names only; src/engine/scene/boundary.test.ts pins the one file that
    // loads each (ink.ts, order.ts).
    'perfect-freehand$',
    'fractional-indexing$',
    // Pure WHATWG parsing: no DOM/global URL, held to Rust by mail host cases.
    'whatwg-url$',
  ].join('|')})`,
);

const RAILS = {
  img: {
    selector: 'JSXOpeningElement[name.name="img"]',
    message:
      'Only FileImage, FileThumb, RemoteImage and Avatar draw <img>: use a reviewed image boundary.',
  },
  // CV-63, no exemption: the design system's Select is a listbox button.
  // Third-party UI that builds a native one is wrapped where it is wired in,
  // as BlockNote's code block is in src/editor/codeBlock.tsx.
  select: {
    selector: [
      'JSXOpeningElement[name.name="select"]',
      'CallExpression[callee.name="createElement"][arguments.0.value=/^select$/i]',
      'CallExpression[callee.property.name="createElement"][arguments.0.value=/^select$/i]',
    ].join(', '),
    message:
      "No native <select> draws anywhere (CV-63): use the design system's Select from '@/components/ui/Select', or Dropdown, which renders it.",
  },
  tauri: {
    pattern: /^@tauri-apps\//,
    message:
      'Tauri loads only in the IPC adapters (src/lib/ipc.ts, src/lib/gitIpc.ts, src/lib/rootsIpc.ts, src/agent/agentIpc.ts): add a function there and call it.',
  },
  mermaid: {
    pattern: /^(?:mermaid|@mermaid-js)(?:\/|$)/,
    message:
      "Only src/mermaid/render.ts and *.mermaid.test.ts load mermaid: render through renderMermaid, and mock '@/mermaid/render' with a fixture svg in a test.",
  },
  pdfjs: {
    pattern: /^pdfjs-dist(?:\/|$)/,
    types: true,
    message:
      'Only src/workspace/viewers/pdf/pdfjs.ts and *.pdf.test.ts load pdfjs-dist: use the PDF loader and mock it in other tests.',
  },
  ironcalc: {
    pattern: /(?:^@ironcalc\/|(?:^|\/)sheetValues\/.*\.wasm)/,
    types: true,
    message:
      "Only src/lib/mockSheet.ts and *.ironcalc.test.ts load @ironcalc/wasm: use calculateSheets from '@/lib/ipc', and mock it in component tests.",
  },
  comments: {
    // M70.1: BlockNote's comments keep threads in the document as marks, which
    // reach the undo history, the save and the clipboard. Comments are drawn
    // by src/editor/commentHighlights.ts as decorations instead.
    pattern: /^@blocknote\/core\/comments(?:\/|$)/,
    message:
      "Only src/editor/commentSpike.test.ts loads '@blocknote/core/comments', to measure it: draw comments with CommentHighlights (src/editor/commentHighlights.ts).",
  },
  mockParse: {
    pattern: /(?:^|\/)mockParse$/,
    message:
      "Only the mock backend (src/lib/mockIpc.ts) reads mockParse: take splitFrontmatter and humanize from '@/engine/frontmatter', and wikilinks from '@/engine/wikilink'.",
  },
  engine: {
    pattern: ENGINE_IMPORTS,
    // `typeof import('…')` names a module too, so the engine checks types.
    types: true,
    message:
      'engine/ is the pure core: it imports engine modules, yaml, the lib leaves deepEqual, slug, templates, sha256, policy/table, policy/tools and policy/toolApproval, views/viewKinds, JSON tables under shared/policy, shared/schema, shared/calendar, shared/files and shared/import, the scene libraries perfect-freehand and fractional-indexing, and the pure URL parser whatwg-url. Move the code into engine/, or have the caller pass the value in.',
  },
};

/** One full set of both rules for the named rails. A regex's `.source`
 * escapes its slashes, so it reads the same in a selector literal. */
function rails(...names) {
  const picked = names.map((name) => RAILS[name]);
  return {
    'no-restricted-imports': [
      'error',
      {
        patterns: picked
          .filter(({ pattern }) => pattern)
          .map(({ pattern, message }) => ({
            regex: pattern.source,
            caseSensitive: true,
            message,
          })),
      },
    ],
    'no-restricted-syntax': [
      'error',
      ...picked.flatMap(({ pattern, message, types, selector }) =>
        selector
          ? [{ selector, message }]
          : [
              { selector: `ImportExpression[source.value=/${pattern.source}/]`, message },
              ...(types
                ? [{ selector: `TSImportType[source.value=/${pattern.source}/]`, message }]
                : []),
            ],
      ),
    ],
  };
}

// Zero-warning policy: `pnpm lint` runs with --max-warnings=0, so a warning
// IS a failure. Suppressions must carry a justification comment — the M14
// audit found exactly one unexplained kind (exhaustive-deps) and it took a
// milestone to pay that down; don't restock it.
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dist-mac/**',
      'docs/**',
      'demo-vault/**',
      'node_modules/**',
      'src-tauri/target/**',
      'src-tauri/.bundle-resources/**',
      'scripts/sheet-values/target/**',
      'src-tauri/gen/**',
      'test-results/**',
      'playwright-report/**',
      'coverage/**',
      '.claude/**',
      '.vite/**',
      // Tracked-by-accident prototype export; relocated in M14.7.
      'HardwareSoftware Security Engineering Tool/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The compiler-era hooks rules (v6) prescribe refactors — effects that
      // clamp state, ref reads during render — that need their own reviewed
      // milestone, not a lint-adoption commit. Candidates to ratchet on later.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/purity': 'off',
      // The codebase idiomatically exports helpers beside components
      // (relativeDay beside KnowledgePanel, GROUPABLE_KINDS beside the
      // toolbar). Restructuring 41 exports buys HMR granularity we haven't
      // missed; off until a session actually chases a stale-HMR bug.
      'react-refresh/only-export-components': 'off',
      // TS owns undefined-name checking; no-undef under TS is all false
      // positives (window, HTMLElement, vitest globals).
      'no-undef': 'off',
      // Matches tsconfig's noUnusedLocals but lets `_`-prefixed args document
      // an intentionally unused parameter in callbacks.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // BlockNote's editor internals (prosemirrorView, _tiptapEditor) are
    // undocumented and untyped upstream; `any` at that boundary is the honest
    // type. Everywhere else the rule stands.
    files: ['src/editor/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Node-side code (build scripts, e2e specs) may use process/console —
    // it is tooling, not product surface.
    files: ['scripts/**', 'e2e/**', '*.config.ts', 'playwright.config.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  // The rails' file classes. Each later object replaces the rail rules of the
  // ones before it, and the specialized classes below never overlap.
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: rails('img', 'select', 'pdfjs', 'ironcalc', 'tauri', 'mermaid', 'mockParse', 'comments'),
  },
  {
    files: ADAPTERS,
    rules: rails('img', 'select', 'pdfjs', 'ironcalc', 'mermaid', 'mockParse', 'comments'),
  },
  {
    files: ['src/mermaid/render.ts', 'src/**/*.mermaid.test.ts'],
    rules: rails('img', 'select', 'pdfjs', 'ironcalc', 'tauri', 'mockParse', 'comments'),
  },
  {
    // The mock backend and the two tests that hold its parser to Rust.
    files: ['src/lib/mockIpc.ts', 'src/lib/mockParse.test.ts', 'src/lib/scanGolden.test.ts'],
    rules: rails('img', 'select', 'pdfjs', 'ironcalc', 'tauri', 'mermaid', 'comments'),
  },
  {
    // Engine tests may import a fixture or a store; the engine itself may not.
    files: ['src/engine/**/*.{ts,tsx}'],
    ignores: ['src/engine/**/*.test.{ts,tsx}'],
    rules: rails(
      'img',
      'select',
      'pdfjs',
      'ironcalc',
      'tauri',
      'mermaid',
      'mockParse',
      'comments',
      'engine',
    ),
  },
  {
    files: ['src/lib/mockSheet.ts', 'src/**/*.ironcalc.test.ts'],
    rules: rails('img', 'select', 'pdfjs', 'tauri', 'mermaid', 'mockParse', 'comments'),
  },
  {
    files: ['src/workspace/viewers/pdf/pdfjs.ts', 'src/**/*.pdf.test.ts'],
    rules: rails('img', 'select', 'ironcalc', 'tauri', 'mermaid', 'mockParse', 'comments'),
  },
  {
    // The M70.1 spike measures BlockNote's comments extension; nothing else
    // loads it.
    files: ['src/editor/commentSpike.test.ts'],
    rules: rails('img', 'select', 'pdfjs', 'ironcalc', 'tauri', 'mermaid', 'mockParse'),
  },
  {
    files: [
      'src/components/FileImage.tsx',
      'src/components/FileThumb.tsx',
      'src/components/RemoteImage.tsx',
      'src/components/ui/Avatar.tsx',
    ],
    rules: rails('select', 'pdfjs', 'ironcalc', 'tauri', 'mermaid', 'mockParse', 'comments'),
  },
);
