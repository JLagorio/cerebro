import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

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
);
