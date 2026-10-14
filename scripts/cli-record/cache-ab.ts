// Gate 2 of M56.12, the A/B: model calls, so it runs only with the owner's
// OK and only after Gate 1 (cache-report.ts) says the prefix is rewritten.
//
//   pnpm tsx scripts/cli-record/cache-ab.ts preview
//   pnpm tsx scripts/cli-record/cache-ab.ts run [--git]
//   pnpm tsx scripts/cli-record/cache-ab.ts reduce
//
// `preview` makes no model call: it prints each arm's per-turn system prompt
// and message sizes, and whether the system prompt changed since the turn
// before.
//
// It reuses the spike's record folder, login and helpers (spike.ts): the
// isolated CLAUDE_CONFIG_DIR signed in once, the child environment with no
// credential, the pinned CLI and the probe's MCP config. Two arms of six haiku
// turns each, joined by --resume and 15 s apart:
//
// - A, today's shape: buildSystemPrompt with the place the person stands, plus
//   renderSnapshot of a toy snapshot, in --append-system-prompt, both changing
//   every turn;
// - B, the move: the same context in a leading block of the user message, and
//   a system prompt that never changes.
//
// The scratch vault is <record>/cache-ab-vault, made fresh for each run. With
// --git it is a git repo with a note change and a commit between turns (pass
// it when the vault Gate 1 measured is one), and the fixture says which.
// `reduce` writes src-tauri/fixtures/cli-stream/spike/cache-ab.json through
// the spike's reducer and prints cache.ts's summary of it.

// The app's prompt modules import Vite's `?raw` text; the tools typecheck
// needs its declarations to follow them.
/// <reference types="vite/client" />

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { registerHooks } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { abSummary, type CacheAbFixture } from './cache';
import { CLI_VERSION, formatJson, reduceScenario } from './reduce';
import { scan } from './scan';
import {
  FIXTURES,
  checkVersion,
  childEnv,
  findSessionFile,
  layout,
  machine,
  readRaw,
  recordRoot,
  refuseRoot,
  runChild,
  sessionFiles,
  setup,
  turnArgv,
  type Layout,
  type Turn,
} from './spike';
import type { ContextSnapshot } from '../../src/agent/context';
import type { PromptGrant } from '../../src/engine/toolGrant';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const TURNS = 6;
export const GAP_MS = 15_000;
export const ARMS = ['a', 'b'] as const;
export type Arm = (typeof ARMS)[number];
const RAW_META = 'cache-ab.json';

/** The place the person stands on each turn: a different note every time. */
export function place(turn: number): { kind: 'doc'; path: string } {
  return { kind: 'doc', path: `notes/${turn % 2 === 0 ? 'alpha' : 'beta'}-${turn}.md` };
}

/** A toy snapshot that changes with the turn, the shape renderSnapshot is given. */
export function snapshot(turn: number): ContextSnapshot {
  const { path } = place(turn);
  return {
    selection: { kind: 'doc', path },
    activeNote: {
      path,
      title: `Note ${turn}`,
      type: null,
      properties: { turn },
      body: `# Note ${turn}\n\nA toy note the person opened on turn ${turn}. It links to Beta.\n`,
    },
    linkedNotes: [{ path: 'notes/beta.md', title: 'Beta', type: null }],
    vault: { types: [], projects: 0, notes: 2 },
  };
}

export const prompt = (turn: number) => `Reply with the one word: ${turn}.`;

/** The leading block arm B carries: the rule M56.12's move would put in contextBlock.ts. */
export function withContext(context: string, message: string): string {
  return `<cerebro-context>\n${context}\n</cerebro-context>\n\n${message}`;
}

export interface Composer {
  buildSystemPrompt(
    selection: { kind: string; path?: string },
    options: { capabilities: string[]; grant: PromptGrant },
  ): string;
  renderSnapshot(snapshot: ContextSnapshot): string;
  grant: PromptGrant;
}

/** One arm's turn: its system prompt and its message. */
export function armTurn(
  arm: Arm,
  turn: number,
  composer: Composer,
): { system: string; message: string } {
  const options = { capabilities: ['knowledge'], grant: composer.grant };
  const rendered = composer.renderSnapshot(snapshot(turn));
  if (arm === 'a') {
    return {
      system: composer.buildSystemPrompt(place(turn), options) + rendered,
      message: prompt(turn),
    };
  }
  const where = `The user is currently looking at ${place(turn).path}.`;
  return {
    system: composer.buildSystemPrompt({ kind: 'none' }, options),
    message: withContext(`${where}\n${rendered}`, prompt(turn)),
  };
}

const RAW = '?raw';

/**
 * The app's own prompt code, loaded under tsx: Vite's `?raw` imports (the
 * product brief, the server instructions) become their file's text.
 */
async function loadComposer(): Promise<Composer> {
  registerHooks({
    resolve(specifier, context, next) {
      if (!specifier.endsWith(RAW)) return next(specifier, context);
      const inner = next(specifier.slice(0, -RAW.length), context);
      return { url: `${inner.url}${RAW}`, shortCircuit: true };
    },
    load(url, context, next) {
      if (!url.endsWith(RAW)) return next(url, context);
      const text = readFileSync(fileURLToPath(url.slice(0, -RAW.length)), 'utf8');
      return {
        format: 'module',
        source: `export default ${JSON.stringify(text)};`,
        shortCircuit: true,
      };
    },
  });
  const prompts = (await import(
    pathToFileURL(join(REPO, 'src/agent/systemPrompt.ts')).href
  )) as typeof import('../../src/agent/systemPrompt');
  const context = (await import(
    pathToFileURL(join(REPO, 'src/agent/context.ts')).href
  )) as typeof import('../../src/agent/context');
  const grants = (await import(
    pathToFileURL(join(REPO, 'src/engine/toolGrant.ts')).href
  )) as typeof import('../../src/engine/toolGrant');
  return {
    buildSystemPrompt: prompts.buildSystemPrompt,
    renderSnapshot: context.renderSnapshot,
    grant: { tools: grants.grantedTools(null), shell: false, attended: true },
  };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function git(vault: string, env: Record<string, string>, args: string[]): void {
  execFileSync(
    'git',
    ['-C', vault, '-c', 'user.name=spike', '-c', 'user.email=spike@example.invalid', ...args],
    { env, stdio: 'ignore' },
  );
}

/** A fresh scratch vault: two notes, a git repo when asked. */
function scratchVault(at: Layout, useGit: boolean, env: Record<string, string>): string {
  const vault = join(at.root, 'cache-ab-vault');
  rmSync(vault, { recursive: true, force: true });
  mkdirSync(join(vault, 'notes'), { recursive: true });
  writeFileSync(join(vault, 'notes/alpha.md'), '# Alpha\n\nA toy note. It mentions Beta.\n');
  writeFileSync(join(vault, 'notes/beta.md'), '# Beta\n\nThe second toy note.\n');
  if (useGit) {
    git(vault, env, ['init', '-q']);
    git(vault, env, ['add', '-A']);
    git(vault, env, ['commit', '-q', '-m', 'start']);
  }
  return vault;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Record one arm into raw/cache-ab-<arm>/, in the layout readRaw reads. */
async function recordArm(arm: Arm, at: Layout, useGit: boolean, composer: Composer): Promise<void> {
  const name = `cache-ab-${arm}`;
  const raw = join(at.raw, name);
  rmSync(raw, { recursive: true, force: true });
  mkdirSync(raw, { recursive: true });
  const env = childEnv(process.env, at.config);
  const vault = scratchVault(at, useGit, env);
  const projects = join(at.config, 'projects');
  const id = randomUUID();
  for (let turn = 1; turn <= TURNS; turn++) {
    if (turn > 1) {
      await sleep(GAP_MS);
      if (useGit) {
        writeFileSync(join(vault, 'notes/alpha.md'), `# Alpha\n\nEdited before turn ${turn}.\n`);
        git(vault, env, ['commit', '-q', '-am', `turn ${turn}`]);
      }
    }
    const { system, message } = armTurn(arm, turn, composer);
    const spec: Turn = {
      prompt: message,
      session: turn === 1 ? { mint: arm } : { resume: arm },
      mode: 'acceptEdits',
      allowed: ['Read'],
      extra: ['--append-system-prompt', system],
    };
    const argv = turnArgv(spec, at, id);
    console.log(`${name} turn ${turn}`);
    const run = await runChild({ program: 'claude', argv, env, cwd: vault, timeoutMs: 300_000 });
    const step = join(raw, String(turn - 1));
    writeJson(`${step}.argv.json`, argv);
    writeFileSync(`${step}.stdout.jsonl`, run.stdout.map((line) => `${line}\n`).join(''));
    writeFileSync(`${step}.stderr.txt`, run.stderr);
    writeJson(`${step}.exit.json`, run.exit);
    writeJson(`${step}.timing.json`, run.timing);
    const session = findSessionFile(projects, id);
    if (session) copyFileSync(session, `${step}.session.jsonl`);
    writeJson(`${step}.session.json`, {
      file: session ? `${id}.jsonl` : null,
      files: sessionFiles(projects),
    });
    if (run.stdout.some((line) => line.includes('"authentication_failed"'))) {
      throw new Error(
        'Claude Code is not signed in in the record folder. Run, once: CLAUDE_CONFIG_DIR=<record>/claude-config claude, then /login, then exit.',
      );
    }
  }
  writeJson(join(raw, 'meta.json'), { cli_version: CLI_VERSION, scenario: name, steps: TURNS });
}

/** Both arms' raw recordings, reduced into one fixture. */
export async function reduceAb(at: Layout): Promise<{ path: string; fixture: CacheAbFixture }> {
  const meta = JSON.parse(readFileSync(join(at.raw, RAW_META), 'utf8')) as { git: boolean };
  const arms = Object.fromEntries(
    ARMS.map((arm) => [arm, reduceScenario(readRaw(join(at.raw, `cache-ab-${arm}`)), machine(at))]),
  ) as unknown as CacheAbFixture['arms'];
  const fixture: CacheAbFixture = {
    cli_version: CLI_VERSION,
    scenario: 'cache-ab',
    source: 'recorded',
    git: meta.git,
    arms,
  };
  const json = await formatJson(fixture);
  const leaks = scan(json);
  if (leaks.length > 0) throw new Error(`Refusing to write cache-ab.json: ${leaks.join('; ')}`);
  mkdirSync(FIXTURES, { recursive: true });
  const path = join(FIXTURES, 'cache-ab.json');
  writeFileSync(path, json);
  return { path, fixture };
}

async function main(argv: string[]): Promise<void> {
  const at = layout(recordRoot(process.env, tmpdir()));
  const real = (path: string) => (existsSync(path) ? realpathSync(path) : path);
  for (const root of [at.root, real(at.root)]) {
    for (const repo of [REPO, real(REPO)]) {
      const refusal = refuseRoot(root, { repo, home: homedir() });
      if (refusal) throw new Error(refusal);
    }
  }
  const [command, flag] = argv;
  if (command === 'preview') {
    const composer = await loadComposer();
    for (const arm of ARMS) {
      let before: string | null = null;
      for (let turn = 1; turn <= TURNS; turn++) {
        const { system, message } = armTurn(arm, turn, composer);
        const changed = before !== null && before !== system;
        console.log(
          `${arm} turn ${turn}: system ${system.length} chars${changed ? ', changed' : ''}, message ${message.length} chars`,
        );
        before = system;
      }
    }
    return;
  }
  if (command === 'run') {
    checkVersion(execFileSync('claude', ['--version'], { encoding: 'utf8' }));
    if (!existsSync(at.mcpConfig)) setup(at);
    const useGit = flag === '--git';
    const composer = await loadComposer();
    for (const arm of ARMS) await recordArm(arm, at, useGit, composer);
    writeJson(join(at.raw, RAW_META), { git: useGit });
    return;
  }
  if (command === 'reduce') {
    const { path, fixture } = await reduceAb(at);
    console.log(path);
    console.log(JSON.stringify(abSummary(fixture), null, 2));
    return;
  }
  throw new Error('usage: cache-ab.ts preview | run [--git] | reduce');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
