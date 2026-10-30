/**
 * Rebuilds the Cerebro design-system artifact's files from this repository (M100.1).
 *
 *   pnpm ds:build                  every file under design-system/out/project, plus
 *                                  out/publish.json: what to upload and publish
 *   pnpm ds:build index <read.json> [--by <name>] [--note <text>]
 *                                  the artifact's index, merged into a copy read
 *                                  from the artifact right before publishing
 *
 * Values come from the app: tokens from src/styles/tokens/*.css, the live
 * component bundle from src/components/{ui,ai}, types from tsc, icons from the
 * lucide-react the app ships. Words come from design-system/: the brand book,
 * each card's preview and guide, and the token notes. Publishing is a Claude
 * Code step (.claude/skills/design-system-sync/SKILL.md): the artifact's tools
 * live there, not here.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { icons as lucide, type LucideIcon } from 'lucide-react';
import { build, type InlineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { ICON_ALIASES } from '../../src/components/ui/Icon';
import { buildTokens, readVars, type TokenNotes } from './tokens';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DS = join(REPO, 'design-system');
const OUT = join(DS, 'out');
const PROJECT = join(OUT, 'project');
const TMP = join(OUT, 'tmp');

interface System {
  url: string;
  title: string;
  namespace: string;
  repo: string;
  /** Card order, which the bundle header and the page follow. */
  cards: string[];
  /** Components outside src/components/{ui,ai} that the bundle also carries. */
  extraModules: string[];
  /** Component modules with no card, each with its reason. */
  uncarded: Record<string, string>;
  fontNotices: string[];
}

interface IconRecord {
  blob: string;
  size: number;
  sha256: string;
}

const read = (path: string) => readFileSync(join(REPO, path), 'utf8');
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const git = (...args: string[]) =>
  spawnSync('git', args, { cwd: REPO, encoding: 'utf8' }).stdout.trim();
const system = JSON.parse(read('design-system/system.json')) as System;
const iconsPath = join(DS, 'icons.json');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

/** Every module the bundle carries, as `@/` paths. */
function modules(): string[] {
  const own = ['ui', 'ai'].flatMap((dir) =>
    readdirSync(join(REPO, 'src/components', dir))
      .filter((f) => /\.tsx?$/.test(f) && !f.includes('.test.'))
      .sort()
      .map((f) => `src/components/${dir}/${f}`),
  );
  return [...own, ...system.extraModules];
}

function tokens(problems: string[]): Set<string> {
  const notes = JSON.parse(read('design-system/tokens.notes.json')) as TokenNotes;
  const built = buildTokens(
    {
      colors: read('src/styles/tokens/colors.css'),
      spacing: read('src/styles/tokens/spacing.css'),
      typography: read('src/styles/tokens/typography.css'),
    },
    notes,
    {
      source: 'github',
      repo: system.repo,
      ref: git('rev-parse', '--short', 'HEAD'),
      paths: {
        tokens: ['colors', 'typography', 'spacing', 'fonts'].map(
          (f) => `src/styles/tokens/${f}.css`,
        ),
        fonts: ['src/assets/fonts/'],
        components: ['src/components/ui/', 'src/components/ai/', ...system.extraModules],
      },
      synced: new Date().toISOString().slice(0, 10),
    },
  );
  problems.push(...built.problems);
  writeFileSync(join(PROJECT, 'tokens.json'), JSON.stringify(built.tokens, null, 1) + '\n');
  for (const font of notes.type.fonts) {
    mkdirSync(join(PROJECT, 'fonts'), { recursive: true });
    cpSync(join(REPO, 'src/assets/fonts', basename(font.file)), join(PROJECT, font.file));
  }
  // Every name tokens.css declares, which no other stylesheet the previews load may redeclare.
  const names = new Set<string>(['font-ui', 'font-mono']);
  const t = built.tokens as Record<string, { tokens?: { name: string }[] }>;
  for (const family of Object.values(t))
    for (const token of family?.tokens ?? []) names.add(token.name);
  return names;
}

/** The bundle's stylesheet entry: the app's index.css without its token files. */
function stylesEntry(): string {
  let css = read('src/styles/index.css');
  const from = (path: string) => relative(TMP, join(REPO, path));
  css = css.replace(
    "@import 'tailwindcss' source('..');",
    [
      "@import 'tailwindcss' source(none);",
      `@source '${from('src/components')}';`,
      `@source '${from('design-system/project/components')}';`,
    ].join('\n'),
  );
  for (const token of ['fonts', 'colors', 'typography', 'spacing', 'base'])
    css = css.replace(`@import './tokens/${token}.css';`, '');
  css = css
    .replace("@import './table-chrome.css';", '')
    .replace("@import './motion.css';", `@import '${from('src/styles/motion.css')}';`)
    .replace(
      "@import './surface-system.css';",
      `@import '${from('src/styles/surface-system.css')}';`,
    )
    .replace(
      "@import '../app/shell.css';",
      [
        `@import '${from('src/app/shell.css')}';`,
        `@import '${from('src/components/pageFrame.css')}';`,
        `@import '${from('src/components/pageToolbar.css')}';`,
      ].join('\n'),
    );
  // Motion has no token family in the artifact, so its pairs stay here.
  const spacing = read('src/styles/tokens/spacing.css');
  const motion = [...readVars(spacing, ':root {')]
    .filter(([name]) => /^(dur|ease|motion)-/.test(name))
    .map(([name, value]) => `  --${name}: ${value};`);
  const reduced = /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}\n/.exec(spacing)![0];
  const base = read('src/styles/tokens/base.css');
  const element = ['a {', 'a:hover {', '::selection {', 'kbd {', 'code {'].map((sel) => {
    const at = base.indexOf(`\n${sel}`) + 1;
    return base.slice(at, base.indexOf('}', at) + 1);
  });
  return `${css}\n:root {\n${motion.join('\n')}\n}\n${reduced}\n${element.join('\n')}\n`;
}

async function viteLib(config: {
  entry: string;
  outDir: string;
  fileName: string;
  external?: string[];
  globals?: Record<string, string>;
  app?: boolean;
}): Promise<void> {
  const inline: InlineConfig = {
    configFile: false,
    root: TMP,
    logLevel: 'warn',
    plugins: config.app ? [react(), tailwindcss()] : [],
    resolve: {
      alias: [
        { find: '@', replacement: join(REPO, 'src') },
        { find: /^shiki$/, replacement: join(REPO, 'scripts/design-system/shiki-subset.ts') },
      ],
    },
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      outDir: config.outDir,
      emptyOutDir: true,
      minify: true,
      sourcemap: config.app ? 'hidden' : false,
      cssCodeSplit: false,
      lib: {
        entry: config.entry,
        formats: ['iife'],
        name: 'CerebroBuild',
        fileName: () => config.fileName,
        cssFileName: 'bundle',
      },
      rollupOptions: {
        external: config.external ?? [],
        output: { inlineDynamicImports: true, globals: config.globals ?? {} },
      },
    },
  };
  await build(inline);
}

/** The live bundle, its stylesheet and the two React libraries; returns the packages the bundle carries. */
async function bundle(tokenNames: Set<string>, problems: string[]): Promise<string[]> {
  const mods = modules();
  writeFileSync(
    join(TMP, 'entry.tsx'),
    [
      ...mods.map((m, i) => `import * as m${i} from '@/${m.slice(4).replace(/\.tsx?$/, '')}';`),
      "import './styles.css';",
      `const mods: Record<string, Record<string, unknown>> = {${mods.map((m, i) => `'${m}': m${i}`).join(', ')}};`,
      'const ns: Record<string, unknown> = {};',
      'const dup: string[] = [];',
      'for (const [path, m] of Object.entries(mods))',
      '  for (const [k, v] of Object.entries(m)) {',
      '    if (k in ns && ns[k] !== v) dup.push(`${k} (${path})`);',
      '    else ns[k] = v;',
      '  }',
      `(window as unknown as Record<string, unknown>).${system.namespace} = ns;`,
      '(window as unknown as Record<string, unknown>).__designSystemDuplicates = dup;',
    ].join('\n'),
  );
  writeFileSync(join(TMP, 'styles.css'), stylesEntry());
  const globals = {
    react: 'React',
    'react-dom': 'ReactDOM',
    'react-dom/client': 'ReactDOM',
    'react/jsx-runtime': 'ReactJSXRuntime',
  };
  await viteLib({
    entry: join(TMP, 'entry.tsx'),
    outDir: join(TMP, 'bundle'),
    fileName: 'bundle.js',
    external: Object.keys(globals),
    globals,
    app: true,
  });
  writeFileSync(
    join(TMP, 'react.js'),
    "import * as React from 'react'; import * as J from 'react/jsx-runtime'; window.React = React; window.ReactJSXRuntime = J;",
  );
  writeFileSync(
    join(TMP, 'react-dom.js'),
    "import * as D from 'react-dom'; import * as C from 'react-dom/client'; window.ReactDOM = Object.assign({}, D, C);",
  );
  const lib = join(PROJECT, 'components/lib');
  mkdirSync(lib, { recursive: true });
  for (const [entry, file, external] of [
    ['react.js', 'react.production.min.js', []],
    ['react-dom.js', 'react-dom.production.min.js', ['react']],
  ] as const) {
    await viteLib({
      entry: join(TMP, entry),
      outDir: join(TMP, entry.replace('.js', '')),
      fileName: file,
      external: [...external],
      globals: { react: 'React' },
    });
    cpSync(join(TMP, entry.replace('.js', ''), file), join(lib, file));
  }

  // A consumer inlines these, so neither may end or escape its element.
  let js = readFileSync(join(TMP, 'bundle/bundle.js'), 'utf8').replaceAll('<!--', '\\x3C!--');
  if (/<\/script/i.test(js)) problems.push('bundle.js contains </script');
  const header = {
    format: 4,
    namespace: system.namespace,
    components: system.cards.map((name) => ({ name })),
  };
  js = `/* @ds-bundle: ${JSON.stringify(header)} */\n${js}`;
  writeFileSync(join(PROJECT, 'components/bundle.js'), js);
  if (js.length > 6 * 1024 * 1024) problems.push(`bundle.js is ${js.length} bytes, over 6 MB`);

  // Tailwind's theme layer declares its own --shadow-* and --font-mono;
  // tokens.css owns those names (one source for every value).
  let css = readFileSync(join(TMP, 'bundle/bundle.css'), 'utf8');
  css = css.replace(/@layer theme\{:root,:host\{([^}]*)\}\}/, (_, body: string) => {
    const kept = body
      .split(';')
      .filter((decl) => !tokenNames.has(decl.trim().split(':')[0].replace(/^--/, '')));
    return `@layer theme{:root,:host{${kept.join(';')}}}`;
  });
  if (/<\/style/i.test(css)) problems.push('bundle.css contains </style');
  writeFileSync(join(PROJECT, 'components/bundle.css'), css);

  const map = JSON.parse(readFileSync(join(TMP, 'bundle/bundle.js.map'), 'utf8')) as {
    sources: string[];
  };
  // The packages inside the bundle, each as the folder its sources came from.
  const dirs = new Set<string>();
  for (const source of map.sources) {
    const path = resolve(TMP, 'bundle', source);
    const at = path.lastIndexOf('/node_modules/') + '/node_modules/'.length;
    if (at < '/node_modules/'.length) continue;
    const [scope, name] = path.slice(at).split('/');
    dirs.add(path.slice(0, at) + (scope.startsWith('@') ? `${scope}/${name}` : scope));
  }
  return [...dirs];
}

/** components/index.d.ts: tsc's declarations for every bundled module and the engine types their props name. */
function types(): void {
  const config = join(TMP, 'tsconfig.dts.json');
  writeFileSync(
    config,
    JSON.stringify({
      extends: relative(TMP, join(REPO, 'tsconfig.json')),
      compilerOptions: {
        noEmit: false,
        declaration: true,
        emitDeclarationOnly: true,
        outDir: 'dts',
        rootDir: relative(TMP, join(REPO, 'src')),
        noUnusedLocals: false,
        noUnusedParameters: false,
        types: ['vite/client'],
      },
      files: modules().map((m) => join(REPO, m)),
      include: [],
    }),
  );
  spawnSync(join(REPO, 'node_modules/.bin/tsc'), ['-p', config], { cwd: TMP, encoding: 'utf8' });
  const dts = join(TMP, 'dts');
  const declared = modules().map((m) => m.slice(4).replace(/\.tsx?$/, ''));
  const refs = new Set<string>();
  for (const m of declared)
    for (const r of readFileSync(join(dts, `${m}.d.ts`), 'utf8').matchAll(/from '@\/([^']+)'/g))
      if (!r[1].startsWith('components/')) refs.add(r[1]);
  const rel = (from: string, spec: string) =>
    spec.startsWith('./') || spec.startsWith('../') ? `@/${join(dirname(from), spec)}` : spec;
  const out = [
    `/* ${system.title} component types: tsc's declarations for every module on window.${system.namespace}, plus the`,
    "   engine types their props name. Documentation, not type-checked; paths are the repository's `@/` paths. */",
    '',
  ];
  for (const m of [...declared, ...[...refs].sort()]) {
    const path = join(dts, `${m}.d.ts`);
    if (!existsSync(path)) continue;
    const body = readFileSync(path, 'utf8')
      .replace(/from '(\.\.?\/[^']+)'/g, (_, s: string) => `from '${rel(m, s)}'`)
      .replace(/import\('(\.\.?\/[^']+)'\)/g, (_, s: string) => `import('${rel(m, s)}')`)
      .replace('export {};\n', '')
      .trim();
    out.push(`declare module '@/${m}' {\n${body.replace(/^(?=.)/gm, '  ')}\n}\n`);
  }
  writeFileSync(join(PROJECT, 'components/index.d.ts'), out.join('\n'));
}

/** The Lucide icons the app names, drawn as its Icon draws them; returns the ones the artifact lacks. */
function iconSet(): {
  order: string[];
  uploads: { name: string; path: string; sha256: string; size: number }[];
} {
  const pascal = (n: string) =>
    n
      .split('-')
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
      .join('');
  const set = lucide as Record<string, LucideIcon | undefined>;
  const known = (n: string) => set[pascal(n)] !== undefined;
  const names = new Set<string>(['square-dashed']);
  const pattern =
    /(?:\bicon|\bname|Icon|ICON|_ICONS?)\w*\s*[=:]\s*\{?\s*['"]([a-z][a-z0-9]*(?:-[a-z0-9]+)*)['"]/g;
  for (const path of files(join(REPO, 'src'))) {
    if (!/\.tsx?$/.test(path) || path.includes('.test.')) continue;
    const text = readFileSync(path, 'utf8');
    const found = [...text.matchAll(pattern)].map((m) => m[1]);
    for (const block of text.matchAll(/ICONS?\b[^=]*=\s*\{([^}]*)\}/g))
      found.push(...[...block[1].matchAll(/:\s*['"]([a-z][a-z0-9-]*)['"]/g)].map((m) => m[1]));
    for (const n of found) {
      const name = known(n) ? n : ICON_ALIASES[n];
      if (name !== undefined && known(name)) names.add(name);
    }
  }
  const record = existsSync(iconsPath)
    ? (JSON.parse(readFileSync(iconsPath, 'utf8')) as Record<string, IconRecord>)
    : {};
  const dir = join(OUT, 'icons');
  mkdirSync(dir, { recursive: true });
  const order = [...names].sort();
  const uploads = [];
  for (const name of order) {
    const Icon = set[pascal(name)]!;
    const svg = renderToStaticMarkup(createElement(Icon, { size: 24, strokeWidth: 1.75 }))
      .replace(/ class="[^"]*"/, '')
      .replace(' aria-hidden="true"', '');
    const path = join(dir, `${name}.svg`);
    writeFileSync(path, svg);
    const hash = sha256(svg);
    if (record[name]?.sha256 !== hash)
      uploads.push({
        name,
        path: relative(REPO, path),
        sha256: hash,
        size: Buffer.byteLength(svg),
      });
  }
  return { order, uploads };
}

function notices(packageDirs: string[]): void {
  const dirs = new Set(packageDirs.map((d) => realpathSync(d)));
  for (const name of ['react', 'react-dom', 'tailwindcss'])
    dirs.add(realpathSync(join(REPO, 'node_modules', name)));
  dirs.add(realpathSync(join(realpathSync(join(REPO, 'node_modules/react-dom')), '../scheduler')));
  const out = [
    `Third-party notices for the ${system.title} design system's components/bundle.js, components/bundle.css`,
    'and components/lib/*.js. These files bundle the open-source packages below; each notice is',
    'reproduced from the package as installed.',
    '',
  ];
  const rule = '='.repeat(72);
  const entries = [...dirs].map((dir) => {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
      license?: string;
    };
    return { dir, pkg };
  });
  for (const { dir, pkg } of entries.sort((a, b) => a.pkg.name.localeCompare(b.pkg.name))) {
    const license = readdirSync(dir).find((f) => /^(licen[cs]e|copying)/i.test(f));
    const readme = readdirSync(dir).find((f) => f.toLowerCase() === 'readme.md');
    const fromReadme = readme
      ? /## License\s+([\s\S]*?)(\n## |$)/.exec(readFileSync(join(dir, readme), 'utf8'))?.[1].trim()
      : undefined;
    out.push(rule, `${pkg.name} ${pkg.version} (${pkg.license ?? 'see notice'})`, rule);
    out.push(
      license
        ? readFileSync(join(dir, license), 'utf8').trim()
        : (fromReadme ?? `Licensed under ${pkg.license}.`),
      '',
    );
  }
  const own = read('THIRD_PARTY_NOTICES.md');
  const at = own.indexOf('## shadcn/ui (AI Elements and their base components)');
  const end = own.indexOf('\n## ', at + 5);
  out.push(
    rule,
    'shadcn/ui: AI Elements and their base components (ported into src/components/ai/)',
    rule,
  );
  out.push(own.slice(own.indexOf('\n', at) + 1, end === -1 ? undefined : end).trim(), '');
  out.push(rule, 'Fonts in fonts/ (SIL Open Font License 1.1, https://openfontlicense.org)', rule);
  out.push(...system.fontNotices, '');
  writeFileSync(join(PROJECT, 'components/THIRD_PARTY_NOTICES.txt'), out.join('\n'));
}

/** Cards against modules and folders: what the person syncing should hear about. */
function drift(problems: string[], warnings: string[]): void {
  const folders = readdirSync(join(DS, 'project/components')).filter((f) =>
    statSync(join(DS, 'project/components', f)).isDirectory(),
  );
  for (const card of system.cards) {
    if (!folders.includes(card)) problems.push(`card ${card} has no folder`);
    for (const file of ['preview.html', 'README.md'])
      if (!existsSync(join(DS, 'project/components', card, file)))
        problems.push(`card ${card} has no ${file}`);
    const preview = join(DS, 'project/components', card, 'preview.html');
    if (
      existsSync(preview) &&
      !/^<!-- @dsCard group="[^"]+" height=\d+/.test(readFileSync(preview, 'utf8'))
    )
      problems.push(`card ${card}: preview.html line 1 is not a @dsCard marker`);
  }
  for (const folder of folders)
    if (folder !== 'Cover' && !system.cards.includes(folder))
      problems.push(`folder components/${folder} is not in system.json cards`);
  for (const module of modules().filter((m) => m.endsWith('.tsx'))) {
    const name = basename(module, '.tsx');
    if (!system.cards.includes(name) && !(name in system.uncarded))
      warnings.push(
        `${module} has no card (add one, or list it in system.json uncarded with a reason)`,
      );
  }
}

async function main(): Promise<void> {
  const problems: string[] = [];
  const warnings: string[] = [];
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  cpSync(join(DS, 'project'), PROJECT, { recursive: true });
  drift(problems, warnings);
  const tokenNames = tokens(problems);
  const packages = await bundle(tokenNames, problems);
  types();
  notices(packages);
  const icons = iconSet();
  const published = files(PROJECT)
    .map((p) => relative(OUT, p))
    .sort();
  writeFileSync(
    join(OUT, 'publish.json'),
    JSON.stringify(
      {
        url: system.url,
        root: relative(REPO, OUT),
        files: published,
        textPlain: published.filter((p) => p.endsWith('.ts')),
        uploads: icons.uploads,
        icons: icons.order,
      },
      null,
      2,
    ) + '\n',
  );
  rmSync(TMP, { recursive: true, force: true });
  for (const w of warnings) console.warn(`design-system: ${w}`);
  console.log(
    `design-system: ${published.length} files in ${relative(REPO, PROJECT)}; ` +
      `${icons.order.length} icons, ${icons.uploads.length} to upload`,
  );
  if (problems.length) {
    for (const p of problems) console.error(`design-system: ${p}`);
    process.exit(1);
  }
}

/** The artifact's index: the copy just read from it, with this build's keys set and every other key kept. */
function index(readPath: string, by: string, note: string): void {
  const base = JSON.parse(readFileSync(resolve(readPath), 'utf8')) as Record<string, unknown>;
  const publish = JSON.parse(readFileSync(join(OUT, 'publish.json'), 'utf8')) as {
    icons: string[];
  };
  const record = JSON.parse(readFileSync(iconsPath, 'utf8')) as Record<string, IconRecord>;
  const missing = publish.icons.filter((n) => !record[n]?.blob);
  if (missing.length)
    throw new Error(
      `no uploaded blob recorded in design-system/icons.json for: ${missing.join(', ')}`,
    );
  const version = (JSON.parse(read('node_modules/react/package.json')) as { version: string })
    .version;
  const groups = (base.groups as string[] | undefined) ?? [];
  const assetGroups = (base.assetGroups as Record<string, unknown> | undefined) ?? {};
  const out = {
    ...base,
    title: system.title,
    namespace: system.namespace,
    libraries: [
      { name: 'react', version, global: 'React', file: 'components/lib/react.production.min.js' },
      {
        name: 'react-dom',
        version,
        global: 'ReactDOM',
        file: 'components/lib/react-dom.production.min.js',
      },
    ],
    groups: groups.includes('Icons') ? groups : [...groups, 'Icons'],
    assetGroups: {
      ...assetGroups,
      Icons: {
        name: 'Icons',
        tile: 'xs',
        order: publish.icons.map((n) => `${n}.svg`),
        files: Object.fromEntries(
          publish.icons.map((n) => [
            `${n}.svg`,
            { name: `${n}.svg`, blob: record[n].blob, size: record[n].size, type: 'image/svg+xml' },
          ]),
        ),
      },
    },
    lastChange: {
      by,
      at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      via: `GitHub · ${system.repo}@${git('rev-parse', '--short', 'HEAD')}`,
      note,
    },
  };
  writeFileSync(join(PROJECT, 'design-system.json'), JSON.stringify(out, null, 1) + '\n');
  console.log(`design-system: index written with ${publish.icons.length} icons`);
}

const [command, ...args] = process.argv.slice(2);
if (command === 'index') {
  const flag = (name: string) => {
    const at = args.indexOf(name);
    return at === -1 ? undefined : args[at + 1];
  };
  if (!args[0])
    throw new Error(
      'usage: pnpm ds:build index <index read from the artifact> [--by <name>] [--note <text>]',
    );
  index(args[0], flag('--by') ?? 'Claude', flag('--note') ?? `Synced from ${system.repo}.`);
} else {
  await main();
}
