// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The scene core's boundary (M68.1, AGENTS.md): src/engine/scene imports only
 * its own files, perfect-freehand from ink.ts alone and fractional-indexing
 * from order.ts alone, reads no clock or randomness, and is typechecked by
 * the no-DOM engine program (tsconfig.engine.json, M53.20).
 */

const REPO = resolve(__dirname, '../../..');
const SCENE = __dirname;
const LIBRARIES: Readonly<Record<string, string>> = {
  'perfect-freehand': 'ink.ts',
  'fractional-indexing': 'order.ts',
};
const SIBLING = /^\.\/[\w-]+$/;

const sceneFiles = () =>
  readdirSync(SCENE)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort();

/** Every module a file names: imports, re-exports, `import()`, `require()` and `import('…')` types. */
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

/** Clock, randomness and crypto tokens the file names (comments and strings don't count). */
function impureTokens(source: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && (node.text === 'Date' || node.text === 'crypto'))
      out.push(node.text);
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Math' &&
      node.name.text === 'random'
    ) {
      out.push('Math.random');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

function parse(name: string, text: string): ts.SourceFile {
  return ts.createSourceFile(name, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}

/** What is wrong with one scene file's imports, as sentences. */
function importProblems(name: string, source: ts.SourceFile): string[] {
  return specifiers(source).flatMap((spec) => {
    if (SIBLING.test(spec)) return [];
    if (name === 'format.ts' && spec === '../../../shared/canvas/format.v1.json') return [];
    if (name === 'canvasLimits.ts' && spec === '../../../shared/canvas/agent-limits.v1.json')
      return [];
    const home = LIBRARIES[spec];
    if (home === name) return [];
    if (home !== undefined) return [`${name} imports ${spec}, which only ${home} may load`];
    return [`${name} imports ${spec}`];
  });
}

describe('the scene core imports only itself and its two upstream libraries', () => {
  it('has files to check', () => {
    expect(sceneFiles()).toEqual(
      expect.arrayContaining(['ink.ts', 'order.ts', 'editor.ts', 'model.ts']),
    );
  });

  it.each(sceneFiles())('%s', (name) => {
    const source = parse(name, readFileSync(join(SCENE, name), 'utf8'));
    expect(importProblems(name, source)).toEqual([]);
  });

  it('loads each library from its one file', () => {
    for (const [library, home] of Object.entries(LIBRARIES)) {
      const source = parse(home, readFileSync(join(SCENE, home), 'utf8'));
      expect(specifiers(source)).toContain(library);
    }
  });

  it('catches what it is there to catch (negative control)', () => {
    const planted = parse(
      'board.ts',
      [
        "import { getStroke } from 'perfect-freehand';",
        "import '../types';",
        "import type { X } from '@/stores/vaultStore';",
        "export { y } from './sub/dir';",
        "const z = await import('yaml');",
        "type T = typeof import('fractional-indexing');",
      ].join('\n'),
    );
    expect(importProblems('board.ts', planted)).toEqual([
      'board.ts imports perfect-freehand, which only ink.ts may load',
      'board.ts imports ../types',
      'board.ts imports @/stores/vaultStore',
      'board.ts imports ./sub/dir',
      'board.ts imports yaml',
      'board.ts imports fractional-indexing, which only order.ts may load',
    ]);
  });
});

describe('the scene core reads no clock or randomness', () => {
  it.each(sceneFiles())('%s', (name) => {
    expect(impureTokens(parse(name, readFileSync(join(SCENE, name), 'utf8')))).toEqual([]);
  });

  it('catches what it is there to catch (negative control)', () => {
    const planted = parse(
      'x.ts',
      [
        '// Date in a comment is fine',
        "const s = 'crypto in a string is fine';",
        'const a = Date.now();',
        'const b = Math.random();',
        'const c = crypto.randomUUID();',
        'const d = new Date();',
      ].join('\n'),
    );
    expect(impureTokens(planted)).toEqual(['Date', 'Math.random', 'crypto', 'Date']);
  });
});

describe('the no-DOM engine typecheck covers the scene core', () => {
  it('builds every scene file in tsconfig.engine.json’s program', () => {
    const configPath = join(REPO, 'tsconfig.engine.json');
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    expect(read.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, REPO, undefined, configPath);
    expect(parsed.options.lib).toEqual(['lib.es2022.d.ts']);
    expect(parsed.options.types).toEqual([]);
    const program = new Set(parsed.fileNames.map((file) => resolve(file)));
    for (const name of sceneFiles()) expect(program).toContain(join(SCENE, name));
    expect(program).not.toContain(join(SCENE, 'boundary.test.ts'));
  });
});
