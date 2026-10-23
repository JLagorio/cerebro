// @vitest-environment node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * CV-64 (M91.7): src/components/ai is presentation only. Its elements take
 * plain props — view models — so every AI surface can draw with them, and
 * none of them reads a store, the app's theme, Rust or the agent model
 * itself. Every module a non-test file names is checked, types included,
 * whether it is spelled `@/…` or reached by a relative path; and every
 * module it loads at run time, through however many app modules, is held
 * to the same list (Attachment once reached a store and an IPC adapter
 * through FileThumb, which only the direct check could not see).
 */

const SRC = resolve(__dirname, '../..');
const AI = __dirname;

/** What the layer may not import, with what the failure calls it. */
const FORBIDDEN: readonly (readonly [RegExp, string])[] = [
  [/^@\/stores(?:\/|$)/, 'a store'],
  [/^@\/hooks\/useTheme(?:\.tsx?)?$/, 'the app theme (take `theme` as a prop)'],
  [/^@\/lib\/(?:ipc|gitIpc|rootsIpc)(?:\.tsx?)?$/, 'an IPC adapter'],
  [/^@\/agent(?:\/|$)/, 'the agent model'],
  [/^@tauri-apps\//, 'Tauri'],
];

/** Every non-test source file in the layer, by its path under it. */
function layerFiles(dir = AI): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return layerFiles(path);
      return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
    })
    .map((path) => relative(AI, path).split(sep).join('/'))
    .sort();
}

/** Every module a file names: imports, re-exports, `import()`, `require()`
 *  and `import('…')` types. A specifier that is not a literal is `<computed>`. */
function specifiers(source: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      out.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const [arg] = node.arguments;
      out.push(arg !== undefined && ts.isStringLiteralLike(arg) ? arg.text : '<computed>');
    } else if (ts.isImportTypeNode(node)) {
      const arg = node.argument;
      out.push(
        ts.isLiteralTypeNode(arg) && ts.isStringLiteral(arg.literal)
          ? arg.literal.text
          : '<computed>',
      );
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const expr = node.moduleReference.expression;
      out.push(ts.isStringLiteral(expr) ? expr.text : '<computed>');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** A relative specifier as the `@/` path it reaches, so `../../stores/x`
 *  is caught as surely as `@/stores/x`. */
function reached(spec: string, file: string): string {
  if (!spec.startsWith('.')) return spec;
  const path = relative(SRC, resolve(dirname(file), spec))
    .split(sep)
    .join('/');
  return path.startsWith('..') ? spec : `@/${path}`;
}

/** What is wrong with one file's imports, as sentences. */
function importProblems(name: string, text: string): string[] {
  const file = join(AI, name);
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.ES2022,
    true,
    name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  return specifiers(source).flatMap((spec) => {
    if (spec === '<computed>') return [`${name} imports a module it computes`];
    const hit = FORBIDDEN.find(([pattern]) => pattern.test(reached(spec, file)));
    return hit === undefined ? [] : [`${name} imports ${spec}: ${hit[1]}`];
  });
}

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.ES2022,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** The modules a file loads when it runs: the bundler erases a type-only
 *  import or re-export (no `verbatimModuleSyntax`), so those are left out. */
function runtimeSpecifiers(source: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const typesOnly =
        clause !== undefined &&
        (clause.isTypeOnly ||
          (clause.name === undefined &&
            bindings !== undefined &&
            ts.isNamedImports(bindings) &&
            bindings.elements.length > 0 &&
            bindings.elements.every((element) => element.isTypeOnly)));
      if (!typesOnly) out.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const clause = node.exportClause;
      const typesOnly =
        node.isTypeOnly ||
        (clause !== undefined &&
          ts.isNamedExports(clause) &&
          clause.elements.length > 0 &&
          clause.elements.every((element) => element.isTypeOnly));
      if (!typesOnly) out.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const [arg] = node.arguments;
      if (arg !== undefined && ts.isStringLiteralLike(arg)) out.push(arg.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** The app source file a specifier loads, or null for a package, a
 *  stylesheet or anything else that is not app code. */
function resolveModule(spec: string, from: string): string | null {
  const bare = spec.split('?')[0];
  let base: string;
  if (bare.startsWith('@/')) base = join(SRC, bare.slice(2));
  else if (bare.startsWith('.')) base = resolve(dirname(from), bare);
  else return null;
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  return (
    candidates.find(
      (candidate) =>
        /\.tsx?$/.test(candidate) && existsSync(candidate) && statSync(candidate).isFile(),
    ) ?? null
  );
}

const asApp = (file: string) => `@/${relative(SRC, file).split(sep).join('/')}`;

/** What a layer file loads at run time, through any chain of app modules,
 *  that the list forbids: each as the chain that reaches it. */
function transitiveProblems(name: string): string[] {
  const start = join(AI, name);
  const via = new Map<string, string | null>([[start, null]]);
  const chain = (file: string): string[] => {
    const parent = via.get(file);
    return parent === null || parent === undefined ? [name] : [...chain(parent), asApp(file)];
  };
  const problems: string[] = [];
  const queue = [start];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    for (const spec of runtimeSpecifiers(parse(file, readFileSync(file, 'utf8')))) {
      const target = resolveModule(spec, file);
      const shown = target === null ? spec : asApp(target);
      const hit = FORBIDDEN.find(([pattern]) => pattern.test(shown));
      if (hit !== undefined) {
        problems.push(`${[...chain(file), shown].join(' → ')}: ${hit[1]}`);
      } else if (target !== null && !via.has(target)) {
        via.set(target, file);
        queue.push(target);
      }
    }
  }
  return problems;
}

describe('the AI element layer is presentation only (CV-64)', () => {
  it('has files to check', () => {
    expect(layerFiles()).toEqual(
      expect.arrayContaining([
        'Badge.tsx',
        'CodeBlock.tsx',
        'Collapsible.tsx',
        'Item.tsx',
        'Trace.tsx',
      ]),
    );
  });

  it.each(layerFiles())('%s', (name) => {
    expect(importProblems(name, readFileSync(join(AI, name), 'utf8'))).toEqual([]);
  });

  it.each(layerFiles())('%s loads nothing forbidden through other modules', (name) => {
    expect(transitiveProblems(name)).toEqual([]);
  });

  it('follows run-time imports through app modules, and not types (negative control)', () => {
    const planted = join(SRC, 'components/FileThumb.tsx');
    const text = readFileSync(planted, 'utf8');
    // FileThumb reaches a store and an IPC adapter through thumbQueue.
    expect(runtimeSpecifiers(parse(planted, text))).toContain('@/lib/thumbQueue');
    const queue = join(SRC, 'lib/thumbQueue.ts');
    expect(
      runtimeSpecifiers(parse(queue, readFileSync(queue, 'utf8'))).map((spec) =>
        asApp(resolveModule(spec, queue) ?? spec),
      ),
    ).toEqual(expect.arrayContaining(['@/lib/rootsIpc.ts', '@/stores/vaultStore.ts']));
    const types = parse(
      'Types.ts',
      [
        "import type { A } from '@/stores/a';",
        "import { type B } from '@/stores/b';",
        "export type { C } from '@/stores/c';",
        "import { D, type E } from '@/stores/d';",
      ].join('\n'),
    );
    expect(runtimeSpecifiers(types)).toEqual(['@/stores/d']);
  });

  it('catches what it is there to catch (negative control)', () => {
    const planted = [
      "import { useVaultStore } from '@/stores/vaultStore';",
      "import { useTheme } from '@/hooks/useTheme';",
      "import type { ChatMessage } from '@/agent/types';",
      "export { askAgent } from '@/agent/agentIpc';",
      "import { scanVault } from '@/lib/ipc';",
      "const git = await import('@/lib/gitIpc');",
      "const roots = require('@/lib/rootsIpc');",
      "type Invoke = typeof import('@tauri-apps/api/core');",
      "import { useUiStore } from '../../stores/uiStore';",
      "import { useTheme as theme } from '../../hooks/useTheme.ts';",
      'const any = await import(where);',
      // What the layer may load: React, the DS, the highlighter, its own files.
      "import { useState } from 'react';",
      "import { Icon } from '@/components/ui/Icon';",
      "import { highlight } from '@/workspace/highlighter';",
      "import { Collapsible } from './Collapsible';",
      "import { useThemeColour } from '@/hooks/useThemeColour';",
    ].join('\n');
    expect(importProblems('Planted.tsx', planted)).toEqual([
      'Planted.tsx imports @/stores/vaultStore: a store',
      'Planted.tsx imports @/hooks/useTheme: the app theme (take `theme` as a prop)',
      'Planted.tsx imports @/agent/types: the agent model',
      'Planted.tsx imports @/agent/agentIpc: the agent model',
      'Planted.tsx imports @/lib/ipc: an IPC adapter',
      'Planted.tsx imports @/lib/gitIpc: an IPC adapter',
      'Planted.tsx imports @/lib/rootsIpc: an IPC adapter',
      'Planted.tsx imports @tauri-apps/api/core: Tauri',
      'Planted.tsx imports ../../stores/uiStore: a store',
      'Planted.tsx imports ../../hooks/useTheme.ts: the app theme (take `theme` as a prop)',
      'Planted.tsx imports a module it computes',
    ]);
  });
});
