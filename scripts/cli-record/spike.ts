// The transport spike's driver (M56.1): it records Claude Code 2.1.250 in an
// isolated config folder against the toy `probe` server, and reduces each
// recording into src-tauri/fixtures/cli-stream/spike/<scenario>.json. Its
// SCRIPTED scenarios (M56.2) are recorded for the real/ corpus only, which
// sanitize.ts writes; they are never reduced.
//
//   pnpm tsx scripts/cli-record/spike.ts setup
//   pnpm tsx scripts/cli-record/spike.ts run <scenario|scripted|all>
//   pnpm tsx scripts/cli-record/spike.ts reduce <scenario|all>
//
// Everything live sits in one record folder outside the repo
// (CEREBRO_RECORD_DIR, else <tmpdir>/cerebro-cli-record): claude-config/
// (the isolated CLAUDE_CONFIG_DIR, signed in once with /login), a fresh
// unsigned-config/ per not-signed-in run, a two-note toy vault/, probe/ (the
// MCP config, the settings files, the decision files and the probe's log)
// and raw/<scenario>/ (argv, stdout, stderr, exit, stdin, timings and a copy
// of each session file). Raw files never enter the repo: `reduce` is the one
// command that writes into it, through reduce.ts and scan.ts. No API key is
// ever used, and the owner's own ~/.claude is never the config.

import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CLI_VERSION,
  formatJson,
  reduceScenario,
  type Machine,
  type RawScenario,
  type RawStep,
} from './reduce';
import { scan } from './scan';

type JsonObject = Record<string, unknown>;

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PROBE = join(REPO, 'scripts/cli-record/probe.ts');
export const FIXTURES = join(REPO, 'src-tauri/fixtures/cli-stream/spike');

export { CLI_VERSION };
/** M53.10's STOP_GRACE: TERM to the group, then KILL after this long. */
export const STOP_GRACE_MS = 2_000;
/** The variables spawn::command scrubs (`spawn.rs` REPO_SELECTING_VARS). */
export const REPO_SELECTING_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
];
/** How long a stream-json child gets to exit after its stdin closes. */
const CLOSE_WAIT_MS = 30_000;
/** The credentials a child must never see. */
export const AUTH_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

const SLOW = 'mcp__probe__slow_echo';
const PROMPT_TOOL = 'mcp__probe__approve';

export interface Layout {
  root: string;
  config: string;
  unsigned: string;
  vault: string;
  probe: string;
  raw: string;
  mcpConfig: string;
  settings: Record<SettingsName, string>;
}

export type SettingsName = 'hook' | 'allow' | 'allow-hook';

export function layout(root: string): Layout {
  const probe = join(root, 'probe');
  return {
    root,
    config: join(root, 'claude-config'),
    unsigned: join(root, 'unsigned-config'),
    vault: join(root, 'vault'),
    probe,
    raw: join(root, 'raw'),
    mcpConfig: join(probe, 'mcp-config.json'),
    settings: {
      hook: join(probe, 'settings-hook.json'),
      allow: join(probe, 'settings-allow.json'),
      'allow-hook': join(probe, 'settings-allow-hook.json'),
    },
  };
}

/** CEREBRO_RECORD_DIR, else <tmpdir>/cerebro-cli-record. */
export function recordRoot(env: NodeJS.ProcessEnv, tmp: string): string {
  const named = env.CEREBRO_RECORD_DIR?.trim();
  return resolve(named ? named : join(tmp, 'cerebro-cli-record'));
}

function inside(path: string, folder: string): boolean {
  const rel = relative(folder, path);
  return rel !== '..' && !rel.startsWith('../') && !rel.startsWith('/');
}

/** Why `root` may not be the record folder, or null when it may. */
export function refuseRoot(root: string, places: { repo: string; home: string }): string | null {
  if (inside(root, places.repo)) {
    return `The record folder ${root} is inside the repo; raw runs must stay outside it.`;
  }
  if (inside(root, join(places.home, '.claude'))) {
    return `The record folder ${root} is under ~/.claude; the spike never touches your own Claude Code config.`;
  }
  return null;
}

/** The version `claude --version` printed, refused unless it is the pin. */
export function checkVersion(printed: string): string {
  const version = /^\s*(\d+\.\d+\.\d+)/.exec(printed)?.[1];
  if (version !== CLI_VERSION) {
    throw new Error(
      `Claude Code ${version ?? 'of an unknown version'} is installed; the spike records ${CLI_VERSION} only.`,
    );
  }
  return version;
}

/**
 * The child's environment: inherited, minus every ANTHROPIC_* and CLAUDE*
 * variable and the repo-selecting git ones, plus CLAUDE_CONFIG_DIR. The
 * prefixes take the three credentials (AUTH_VARS) and, as well, a parent
 * Claude Code session's own variables: a driver started from inside one
 * would otherwise record that session's entrypoint, effort and socket.
 */
export function childEnv(parent: NodeJS.ProcessEnv, configDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined || REPO_SELECTING_VARS.includes(key) || AUTH_VARS.includes(key)) {
      continue;
    }
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_') || key.startsWith('ANTHROPIC_')) continue;
    env[key] = value;
  }
  env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}

// ---------------------------------------------------------------------------
// Scenarios: what each records, as data.
// ---------------------------------------------------------------------------

export interface Turn {
  prompt: string;
  /** A key for a session the driver mints (`--session-id`), or one it resumes. */
  session: { mint: string } | { resume: string };
  mode: 'acceptEdits' | 'default';
  allowed: string[];
  /** Defaults to haiku. */
  model?: string;
  extra?: string[];
  promptTool?: boolean;
  settings?: SettingsName;
  /** decisions.json for the prompt tool, written before the turn. */
  decisions?: (at: Layout) => JsonObject;
  /** hook-decisions.json for the PreToolUse hook, written before the turn. */
  hookDecisions?: JsonObject;
  /** Stop the child's group at the first stdout line that matches. */
  stopOn?: Matcher;
}

export type Matcher = 'init' | 'result' | 'tool_use' | 'text_delta' | 'can_use_tool' | 'response';

export type ScriptStep =
  { send: JsonObject } | { until: Matcher } | { hold: number } | { allow: true } | { close: true };

export interface Scenario {
  /** The D4 record's facts this scenario's fixture answers (F20 is timings only). */
  facts: string[];
  /** Run in a config folder made fresh for this run, never signed in. */
  unsigned?: boolean;
  turns: Turn[];
  /** One long-lived stream-json child, driven by a stdin script. */
  stream?: (holdMs: number, settleMs?: number) => ScriptStep[];
}

const acceptEdits: Pick<Turn, 'mode' | 'allowed'> = { mode: 'acceptEdits', allowed: [SLOW] };
const asking: Pick<Turn, 'mode' | 'allowed'> = { mode: 'default', allowed: [SLOW] };
const hookSays = (decision: string, reason: string): Partial<Turn> => ({
  settings: 'hook',
  hookDecisions: { [SLOW]: { permissionDecision: decision, permissionDecisionReason: reason } },
});
const DEFER = hookSays('defer', 'Waiting for the person to answer.');
const ASK =
  "Use the AskUserQuestion tool to ask me one question, 'Which color?', with the two options Red and Blue. Then reply with the color I picked.";
const WRITE =
  'Use the Write tool to create notes/gamma.md containing the word hello, then reply done.';
const RULE = "Call slow_echo once with text 'rule' and seconds 0, then reply done.";

function user(text: string): JsonObject {
  return {
    type: 'user',
    session_id: '',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

function request(subtype: string, fields: JsonObject = {}): JsonObject {
  return { type: 'control_request', request: { subtype, ...fields } };
}

/**
 * The stream-json child's stdin: the held permission lasts `holdMs`, and the
 * mid-tool message goes `settleMs` after the 20 s call is allowed.
 */
export function streamScript(holdMs: number, settleMs = 3_000): ScriptStep[] {
  return [
    { send: request('initialize') },
    { until: 'response' },
    { send: user("Call slow_echo once with text 'held' and seconds 0, then reply done.") },
    { until: 'can_use_tool' },
    { hold: holdMs },
    { allow: true },
    { until: 'result' },
    { send: request('set_model', { model: 'sonnet' }) },
    { until: 'response' },
    { send: user('Reply with the one word: sonnet.') },
    { until: 'result' },
    { send: user('Write a 400-word story about a lighthouse keeper.') },
    { until: 'text_delta' },
    { send: request('interrupt') },
    { until: 'response' },
    { until: 'result' },
    { send: user('Reply with the one word: after.') },
    { until: 'result' },
    { send: user("Call slow_echo once with text 'long' and seconds 20, then reply done.") },
    { until: 'can_use_tool' },
    { allow: true },
    { hold: settleMs },
    { send: user('Reply with the one word: queued.') },
    { until: 'result' },
    { until: 'result' },
    { send: request('mcp_status') },
    { until: 'response' },
    { close: true },
  ];
}

export const SCENARIOS = {
  'not-signed-in': {
    facts: ['F0', 'F1', 'F9', 'F20'],
    unsigned: true,
    turns: [{ ...acceptEdits, prompt: 'Reply ok.', session: { mint: 'a' } }],
  },
  'resume-usage': {
    facts: ['F1', 'F2', 'F3', 'F19'],
    turns: [
      { ...acceptEdits, prompt: 'Reply with the one word: one.', session: { mint: 'a' } },
      { ...acceptEdits, prompt: 'Reply with the one word: two.', session: { resume: 'a' } },
      {
        ...acceptEdits,
        prompt: 'Reply with the one word: three.',
        session: { resume: 'a' },
        model: 'sonnet',
        extra: ['--effort', 'low'],
      },
    ],
  },
  'defer-resume': {
    facts: ['F4', 'F5', 'F6', 'F7'],
    turns: [
      {
        ...acceptEdits,
        ...DEFER,
        prompt: "Call slow_echo once with text 'alpha' and seconds 0, then reply done.",
        session: { mint: 'a' },
      },
      {
        ...acceptEdits,
        ...hookSays('allow', 'The person allowed it.'),
        prompt: 'Continue.',
        session: { resume: 'a' },
      },
      {
        ...acceptEdits,
        ...DEFER,
        prompt: "Call slow_echo once with text 'beta' and seconds 0, then reply done.",
        session: { mint: 'b' },
      },
      {
        ...acceptEdits,
        ...hookSays('deny', 'Not today.'),
        prompt: 'Continue.',
        session: { resume: 'b' },
      },
      {
        ...acceptEdits,
        ...DEFER,
        prompt:
          "Call slow_echo twice in one message, once with text 'one' and once with text 'two', seconds 0 each, then reply done.",
        session: { mint: 'c' },
      },
      {
        ...acceptEdits,
        ...hookSays('allow', 'The person allowed both.'),
        prompt: 'Continue.',
        session: { resume: 'c' },
      },
    ],
  },
  'prompt-tool': {
    facts: ['F8'],
    turns: [
      { ...asking, prompt: WRITE, session: { mint: 'a' } },
      {
        ...asking,
        prompt: WRITE,
        session: { mint: 'b' },
        promptTool: true,
        decisions: (at) => ({
          Write: {
            behavior: 'allow',
            updatedInput: { file_path: join(at.vault, 'notes/gamma-approved.md') },
          },
        }),
      },
      {
        ...asking,
        prompt: WRITE,
        session: { mint: 'c' },
        promptTool: true,
        decisions: () => ({ Write: { behavior: 'deny', message: 'Not now.' } }),
      },
    ],
  },
  'ask-question': {
    facts: ['F9'],
    turns: [
      { ...asking, prompt: ASK, session: { mint: 'a' } },
      {
        ...asking,
        prompt: ASK,
        session: { mint: 'b' },
        promptTool: true,
        decisions: () => ({ AskUserQuestion: { behavior: 'allow', answer: 'Blue' } }),
      },
    ],
  },
  'allow-rule': {
    facts: ['F10'],
    turns: [
      {
        mode: 'default',
        allowed: ['Read'],
        settings: 'allow',
        promptTool: true,
        decisions: () => ({ [SLOW]: { behavior: 'deny', message: 'The prompt tool was asked.' } }),
        prompt: RULE,
        session: { mint: 'a' },
      },
      {
        mode: 'default',
        allowed: ['Read'],
        ...DEFER,
        settings: 'allow-hook',
        promptTool: true,
        decisions: () => ({ [SLOW]: { behavior: 'deny', message: 'The prompt tool was asked.' } }),
        prompt: RULE,
        session: { mint: 'b' },
      },
    ],
  },
  'stream-json': {
    facts: ['F11', 'F12', 'F13', 'F14', 'F15', 'F16', 'F19', 'F20'],
    turns: [],
    stream: streamScript,
  },
  'kill-resume': {
    facts: ['F17', 'F18'],
    turns: [
      {
        ...acceptEdits,
        prompt: "Call slow_echo once with text 'stop' and seconds 30, then reply done.",
        session: { mint: 'a' },
        stopOn: 'tool_use',
      },
      { ...acceptEdits, prompt: 'Continue.', session: { resume: 'a' } },
      {
        ...acceptEdits,
        prompt: 'Write a 300-word story about a fox who keeps a lighthouse.',
        session: { mint: 'b' },
        stopOn: 'text_delta',
      },
      { ...acceptEdits, prompt: 'Continue.', session: { resume: 'b' } },
    ],
  },
} satisfies Record<string, Scenario>;

export type ScenarioName = keyof typeof SCENARIOS;
export const SCENARIO_NAMES = Object.keys(SCENARIOS) as ScenarioName[];

/**
 * M56.2's scripted scenarios: kinds the spike's own runs never show, recorded
 * for sanitize.ts's corpus (scripted-<name>) and never reduced, so they answer
 * no fact.
 */
export const SCRIPTED = {
  thinking: {
    facts: [],
    turns: [
      {
        ...acceptEdits,
        prompt: 'Think it through, then reply with one word: which of 17 and 21 is prime?',
        session: { mint: 'a' },
        model: 'sonnet',
        extra: ['--effort', 'high'],
      },
    ],
  },
  bash: {
    facts: [],
    turns: [
      {
        mode: 'acceptEdits',
        allowed: ['Bash'],
        prompt: 'Use the Bash tool to run ls notes, then reply with the file names it printed.',
        session: { mint: 'a' },
      },
    ],
  },
  'max-turns': {
    facts: [],
    turns: [
      {
        ...acceptEdits,
        prompt:
          "Call slow_echo with text 'one' and seconds 0, then call it again with text 'two' and seconds 0, then reply done.",
        session: { mint: 'a' },
        extra: ['--max-turns', '1'],
      },
    ],
  },
} satisfies Record<string, Scenario>;

export type ScriptedName = keyof typeof SCRIPTED;
export const SCRIPTED_NAMES = Object.keys(SCRIPTED) as ScriptedName[];
/** Everything `run` records: the spike's scenarios, then the scripted ones. */
export type RunName = ScenarioName | ScriptedName;
const RUNNABLE: Record<RunName, Scenario> = { ...SCENARIOS, ...SCRIPTED };

/**
 * One turn's argv: build_args' shared flags at M55's tip on haiku, then the
 * scenario's own. `sessionId` is the minted id for `--session-id`, or the
 * one `--resume` continues.
 */
export function turnArgv(turn: Turn, at: Layout, sessionId: string): string[] {
  const argv = [
    '-p',
    turn.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--mcp-config',
    at.mcpConfig,
    '--permission-mode',
    turn.mode,
    '--allowedTools',
    turn.allowed.join(','),
    '--setting-sources',
    'user',
    '--strict-mcp-config',
  ];
  if (turn.settings) argv.push('--settings', at.settings[turn.settings]);
  if (turn.promptTool) argv.push('--permission-prompt-tool', PROMPT_TOOL);
  argv.push('--model', turn.model ?? 'haiku', ...(turn.extra ?? []));
  argv.push('mint' in turn.session ? '--session-id' : '--resume', sessionId);
  return argv;
}

/** The long-lived child's argv: stdin and stdout both stream-json, prompts on stdio. */
export function streamArgv(at: Layout, sessionId: string): string[] {
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--mcp-config',
    at.mcpConfig,
    '--permission-mode',
    'default',
    '--allowedTools',
    'Read',
    '--setting-sources',
    'user',
    '--strict-mcp-config',
    '--permission-prompt-tool',
    'stdio',
    '--model',
    'haiku',
    '--session-id',
    sessionId,
  ];
}

// ---------------------------------------------------------------------------
// The record folder.
// ---------------------------------------------------------------------------

function quote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** Create the record folder: the toy vault, the probe's config and settings. */
export function setup(at: Layout, node: string = process.execPath): void {
  for (const dir of [at.config, join(at.vault, 'notes'), at.probe, at.raw]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(
    join(at.vault, 'notes/alpha.md'),
    '# Alpha\n\nA toy note for recording Claude Code. It mentions Beta.\n',
  );
  writeFileSync(join(at.vault, 'notes/beta.md'), '# Beta\n\nThe second toy note.\n');
  // M56.2's app recordings: an agent whose run is refused a write outside its
  // scope, and the note it is asked to change.
  mkdirSync(join(at.vault, 'records/agents'), { recursive: true });
  mkdirSync(join(at.vault, 'outside'), { recursive: true });
  writeFileSync(join(at.vault, 'records/agents/scout.md'), SCOUT);
  writeFileSync(
    join(at.vault, 'outside/secret.md'),
    '# Outside\n\nA note outside the scout scope.\n',
  );
  const server = { type: 'stdio', command: node, args: [PROBE, 'server', '--dir', at.probe] };
  writeJson(at.mcpConfig, { mcpServers: { probe: server } });
  const hook = {
    PreToolUse: [
      {
        matcher: SLOW,
        hooks: [
          {
            type: 'command',
            command: [node, PROBE, 'hook', '--dir', at.probe].map(quote).join(' '),
          },
        ],
      },
    ],
  };
  const allow = { allow: [SLOW] };
  writeJson(at.settings.hook, { hooks: hook });
  writeJson(at.settings.allow, { permissions: allow });
  writeJson(at.settings['allow-hook'], { permissions: allow, hooks: hook });
  writeJson(join(at.probe, 'decisions.json'), {});
  writeJson(join(at.probe, 'hook-decisions.json'), {});
}

/**
 * The toy agent app-agent-refused records: scoped to notes/, asked to append
 * outside it. Its schedule is a placeholder the owner moves a few minutes
 * ahead before recording.
 */
export const SCOUT = `---
type: Agent
slug: scout
description: A toy agent for recording a refused write.
tools: safe
scope:
  - notes
schedule: daily 09:00
---

# Scout

Append the line "scouted" to outside/secret.md with append_to_note, then reply
with what happened.
`;

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** `<projects>/*\/<id>.jsonl`, found by glob, never by re-deriving the slug. */
export function findSessionFile(projects: string, id: string): string | null {
  if (!existsSync(projects)) return null;
  for (const entry of readdirSync(projects, { withFileTypes: true })) {
    const path = join(projects, entry.name, `${id}.jsonl`);
    if (entry.isDirectory() && existsSync(path)) return path;
  }
  return null;
}

/** Every session file under `<projects>/*\/`, by name. */
export function sessionFiles(projects: string): string[] {
  if (!existsSync(projects)) return [];
  return readdirSync(projects, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => readdirSync(join(projects, entry.name)))
    .filter((name) => name.endsWith('.jsonl'))
    .sort();
}

// ---------------------------------------------------------------------------
// Children.
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function lineMatches(line: unknown, matcher: Matcher, requestId?: string): boolean {
  if (!isObject(line)) return false;
  const message = isObject(line.message) ? line.message : {};
  const event = isObject(line.event) ? line.event : {};
  const body = isObject(line.request) ? line.request : isObject(line.response) ? line.response : {};
  switch (matcher) {
    case 'init':
      return line.type === 'system' && line.subtype === 'init';
    case 'result':
      return line.type === 'result';
    case 'tool_use':
      return (
        line.type === 'assistant' &&
        Array.isArray(message.content) &&
        message.content.some((block) => isObject(block) && block.type === 'tool_use')
      );
    case 'text_delta':
      return (
        line.type === 'stream_event' &&
        event.type === 'content_block_delta' &&
        isObject(event.delta) &&
        event.delta.type === 'text_delta'
      );
    case 'can_use_tool':
      return line.type === 'control_request' && body.subtype === 'can_use_tool';
    case 'response':
      return line.type === 'control_response' && body.request_id === requestId;
  }
}

/**
 * End a child's process group: TERM, then KILL once `graceMs` passes without
 * it exiting. Never group 1 or below, and never the driver's own group.
 */
export async function stopGroup(
  pgid: number,
  own: number,
  deps: {
    kill(pid: number, signal: NodeJS.Signals): void;
    exited(ms: number): Promise<boolean>;
    graceMs?: number;
  },
): Promise<'term' | 'kill'> {
  if (!Number.isInteger(pgid) || pgid <= 1)
    throw new Error(`Refusing to signal process group ${pgid}.`);
  if (pgid === own) throw new Error("Refusing to signal the driver's own process group.");
  const signal = (name: NodeJS.Signals) => {
    try {
      deps.kill(-pgid, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  signal('SIGTERM');
  if (await deps.exited(deps.graceMs ?? STOP_GRACE_MS)) return 'term';
  signal('SIGKILL');
  return 'kill';
}

/** The driver's own process group, read once from `ps`. */
export function ownGroup(): number {
  return Number(
    execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }),
  );
}

export interface ChildSpec {
  program: string;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  script?: ScriptStep[];
  stopOn?: Matcher;
  graceMs?: number;
  /** How long a scripted child may take to exit once its stdin closes. */
  closeWaitMs?: number;
  timeoutMs: number;
}

export interface ChildRun {
  stdout: string[];
  stdin: string[];
  stderr: string;
  exit: { code: number | null; signal: string | null; stopped: boolean };
  /** Milliseconds from spawn: never pinned, only written in the D4 record. */
  timing: { init_ms: number | null; first_delta_ms: number | null; exit_ms: number };
}

/**
 * Start one child in its own process group, read its stdout line by line,
 * drive its stdin script if it has one, and stop the group on `stopOn`, on a
 * script that cannot go on, or at `timeoutMs`.
 */
export function runChild(spec: ChildSpec): Promise<ChildRun> {
  const own = ownGroup();
  const started = performance.now();
  const since = () => Math.round(performance.now() - started);
  const child = spawn(spec.program, spec.argv, {
    cwd: spec.cwd,
    env: spec.env,
    detached: true,
    stdio: [spec.script ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  const { stdin, stdout, stderr } = child;
  if (!stdout || !stderr) throw new Error('The child started without its output pipes.');
  // A write after the child exits fails with EPIPE; the run keeps what it read.
  stdin?.on('error', () => {});
  const run: ChildRun = {
    stdout: [],
    stdin: [],
    stderr: '',
    exit: { code: null, signal: null, stopped: false },
    timing: { init_ms: null, first_delta_ms: null, exit_ms: 0 },
  };
  const parsed: unknown[] = [];
  let wake: () => void = () => {};
  let exited = false;
  const exit = new Promise<void>((done) =>
    child.on('close', (code, signal) => {
      exited = true;
      run.exit.code = code;
      run.exit.signal = signal;
      run.timing.exit_ms = since();
      wake();
      done();
    }),
  );
  const stop = async () => {
    if (exited || run.exit.stopped || child.pid === undefined) return;
    run.exit.stopped = true;
    await stopGroup(child.pid, own, {
      kill: (pid, signal) => process.kill(pid, signal),
      exited: (ms) =>
        Promise.race([
          exit.then(() => true),
          new Promise<boolean>((r) => setTimeout(r, ms, false)),
        ]),
      graceMs: spec.graceMs,
    });
  };
  const timer = setTimeout(() => void stop(), spec.timeoutMs);
  const take = (line: string) => {
    if (line.trim() === '') return;
    run.stdout.push(line);
    let value: unknown = null;
    try {
      value = JSON.parse(line);
    } catch {
      // Kept raw in stdout; the reducer records it as unparsed.
    }
    parsed.push(value);
    if (run.timing.init_ms === null && lineMatches(value, 'init')) run.timing.init_ms = since();
    if (
      run.timing.first_delta_ms === null &&
      isObject(value) &&
      value.type === 'stream_event' &&
      isObject(value.event) &&
      value.event.type === 'content_block_delta'
    ) {
      run.timing.first_delta_ms = since();
    }
    if (spec.stopOn && lineMatches(value, spec.stopOn)) void stop();
  };
  let buffered = '';
  stdout.setEncoding('utf8');
  stdout.on('data', (chunk: string) => {
    const lines = (buffered + chunk).split('\n');
    buffered = lines.pop() ?? '';
    lines.forEach(take);
    wake();
  });
  // A last line with no newline still counts.
  stdout.on('end', () => take(buffered));
  stderr.setEncoding('utf8').on('data', (chunk: string) => (run.stderr += chunk));

  const script = async (steps: ScriptStep[]) => {
    let mark = 0;
    let requests = 0;
    let lastRequest: string | undefined;
    let lastAsk: JsonObject | undefined;
    const used = new Set<number>();
    const write = (value: JsonObject) => {
      const line = JSON.stringify(value);
      run.stdin.push(line);
      stdin?.write(`${line}\n`);
    };
    for (const step of steps) {
      if ('send' in step) {
        let value = step.send;
        if (value.type === 'control_request') {
          lastRequest = `req_${++requests}`;
          value = { ...value, request_id: lastRequest };
        }
        mark = parsed.length;
        write(value);
      } else if ('until' in step) {
        for (;;) {
          const found = parsed.findIndex(
            (line, index) =>
              index >= mark && !used.has(index) && lineMatches(line, step.until, lastRequest),
          );
          if (found !== -1) {
            used.add(found);
            if (step.until === 'can_use_tool') lastAsk = parsed[found] as JsonObject;
            break;
          }
          if (exited) return;
          await new Promise<void>((done) => (wake = done));
        }
      } else if ('hold' in step) {
        await new Promise((done) => setTimeout(done, step.hold));
      } else if ('allow' in step) {
        const ask = isObject(lastAsk?.request) ? lastAsk.request : {};
        write({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: lastAsk?.request_id,
            response: { behavior: 'allow', updatedInput: ask.input ?? {} },
          },
        });
      } else {
        stdin?.end();
      }
    }
  };

  return (async () => {
    if (spec.script) {
      await script(spec.script);
      // A child that ignores the closed stdin, or a script that could not go
      // on, still ends: it gets CLOSE_WAIT_MS to finish, then the group stops.
      stdin?.end();
      const done = await Promise.race([
        exit.then(() => true),
        new Promise<boolean>((r) => setTimeout(r, spec.closeWaitMs ?? CLOSE_WAIT_MS, false)),
      ]);
      if (!done) await stop();
    }
    await exit;
    clearTimeout(timer);
    return run;
  })();
}

// ---------------------------------------------------------------------------
// Runs.
// ---------------------------------------------------------------------------

export interface RunOptions {
  program: string;
  /** How long the stream-json scenario holds its permission; 120 s live. */
  holdMs: number;
  /** How long it waits into the 20 s call before sending mid-turn; 3 s live. */
  settleMs?: number;
  graceMs?: number;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  log(line: string): void;
}

const NOT_SIGNED_IN =
  'Claude Code is not signed in in the record folder. Run, once: CLAUDE_CONFIG_DIR=<record>/claude-config claude, then /login, then exit.';

function signedOut(stdout: string[]): boolean {
  return stdout.some((line) => line.includes('"authentication_failed"'));
}

/** Record one scenario into raw/<name>/, replacing what was there. */
export async function runScenario(name: RunName, at: Layout, options: RunOptions): Promise<void> {
  const scenario: Scenario = RUNNABLE[name];
  const raw = join(at.raw, name);
  rmSync(raw, { recursive: true, force: true });
  mkdirSync(raw, { recursive: true });
  const config = scenario.unsigned ? at.unsigned : at.config;
  if (scenario.unsigned) {
    rmSync(at.unsigned, { recursive: true, force: true });
    mkdirSync(at.unsigned, { recursive: true });
  }
  const env = childEnv(options.env, config);
  const projects = join(config, 'projects');
  const log = join(at.probe, 'log.jsonl');
  const sessions = new Map<string, string>();
  const turns: (Turn | null)[] = scenario.stream ? [null] : scenario.turns;
  for (const [index, turn] of turns.entries()) {
    const key = turn
      ? 'mint' in turn.session
        ? turn.session.mint
        : turn.session.resume
      : 'stream';
    if (!sessions.has(key)) sessions.set(key, randomUUID());
    const id = sessions.get(key) as string;
    writeJson(join(at.probe, 'decisions.json'), turn?.decisions?.(at) ?? {});
    writeJson(join(at.probe, 'hook-decisions.json'), turn?.hookDecisions ?? {});
    const logStart = existsSync(log) ? statSync(log).size : 0;
    const argv = turn ? turnArgv(turn, at, id) : streamArgv(at, id);
    options.log(`${name} step ${index}: claude ${argv.slice(0, 2).join(' ')} …`);
    const run = await runChild({
      program: options.program,
      argv,
      env,
      cwd: at.vault,
      script: scenario.stream?.(options.holdMs, options.settleMs),
      stopOn: turn?.stopOn,
      graceMs: options.graceMs,
      timeoutMs: options.timeoutMs,
    });
    const step = join(raw, String(index));
    writeJson(`${step}.argv.json`, argv);
    writeFileSync(`${step}.stdout.jsonl`, run.stdout.map((line) => `${line}\n`).join(''));
    writeFileSync(`${step}.stderr.txt`, run.stderr);
    writeJson(`${step}.exit.json`, run.exit);
    writeJson(`${step}.timing.json`, run.timing);
    if (run.stdin.length > 0) {
      writeFileSync(`${step}.stdin.jsonl`, run.stdin.map((line) => `${line}\n`).join(''));
    }
    const session = findSessionFile(projects, id);
    if (session) copyFileSync(session, `${step}.session.jsonl`);
    writeJson(`${step}.session.json`, {
      file: session ? `${id}.jsonl` : null,
      files: sessionFiles(projects),
    });
    const probe = existsSync(log) ? readFileSync(log).subarray(logStart).toString('utf8') : '';
    writeFileSync(`${step}.probe.jsonl`, probe);
    options.log(`  exit ${JSON.stringify(run.exit)} · ${JSON.stringify(run.timing)}`);
    if (!scenario.unsigned && signedOut(run.stdout)) throw new Error(NOT_SIGNED_IN);
  }
  writeJson(join(raw, 'meta.json'), {
    cli_version: CLI_VERSION,
    scenario: name,
    steps: turns.length,
  });
}

/** One scenario's raw folder, read back for the reducer. */
export function readRaw(rawDir: string): RawScenario {
  const meta = JSON.parse(readFileSync(join(rawDir, 'meta.json'), 'utf8')) as {
    cli_version: string;
    scenario: string;
    steps: number;
  };
  const text = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
  const lines = (path: string) =>
    text(path)
      .split('\n')
      .filter((line) => line.trim() !== '');
  const steps: RawStep[] = [];
  for (let index = 0; index < meta.steps; index++) {
    const step = join(rawDir, String(index));
    const session = JSON.parse(text(`${step}.session.json`) || '{"file":null,"files":[]}') as {
      file: string | null;
      files: string[];
    };
    steps.push({
      argv: JSON.parse(text(`${step}.argv.json`)) as string[],
      stdout: lines(`${step}.stdout.jsonl`),
      stdin: lines(`${step}.stdin.jsonl`),
      stderr: text(`${step}.stderr.txt`),
      exit: JSON.parse(text(`${step}.exit.json`)) as RawStep['exit'],
      session: { ...session, lines: lines(`${step}.session.jsonl`) },
      probe: lines(`${step}.probe.jsonl`),
    });
  }
  return { cli_version: meta.cli_version, scenario: meta.scenario, steps };
}

function gitConfig(key: string): string {
  try {
    return execFileSync('git', ['config', key], { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** What this machine would leak into a fixture, for the reducer to replace. */
export function machine(at: Layout): Machine {
  return {
    recordDir: at.root,
    realRecordDir: existsSync(at.root) ? realpathSync(at.root) : undefined,
    repo: REPO,
    home: homedir(),
    user: userInfo().username,
    host: hostname(),
    gitName: gitConfig('user.name'),
    gitEmail: gitConfig('user.email'),
  };
}

/** Reduce raw/<name>/ into the fixture, refusing to write past a scan hit. */
export async function reduceToFixture(name: string, at: Layout, out: string): Promise<string> {
  const fixture = reduceScenario(readRaw(join(at.raw, name)), machine(at));
  const json = await formatJson(fixture);
  const leaks = scan(json);
  if (leaks.length > 0) {
    throw new Error(`Refusing to write ${name}.json: ${leaks.join('; ')}`);
  }
  mkdirSync(out, { recursive: true });
  const path = join(out, `${name}.json`);
  writeFileSync(path, json);
  return path;
}

/** The scenarios a command names: one by name, or all. */
export function pick(arg: string | undefined): ScenarioName[] {
  if (arg === 'all') return SCENARIO_NAMES;
  const named = SCENARIO_NAMES.find((name) => name === arg);
  if (named) return [named];
  throw new Error(`Name a scenario or all: ${SCENARIO_NAMES.join(', ')}.`);
}

/** What `run` records: one scenario or scripted run by name, or all of both. */
export function pickRun(arg: string | undefined): RunName[] {
  const names: RunName[] = [...SCENARIO_NAMES, ...SCRIPTED_NAMES];
  if (arg === 'all') return names;
  const named = names.find((name) => name === arg);
  if (named) return [named];
  throw new Error(`Name a scenario, a scripted run or all: ${names.join(', ')}.`);
}

async function main(argv: string[]): Promise<void> {
  const at = layout(recordRoot(process.env, tmpdir()));
  // A symlink must not carry the record folder into the repo either.
  const real = (path: string) => (existsSync(path) ? realpathSync(path) : path);
  for (const root of [at.root, real(at.root)]) {
    for (const repo of [REPO, real(REPO)]) {
      const refusal = refuseRoot(root, { repo, home: homedir() });
      if (refusal) throw new Error(refusal);
    }
  }
  const [command, arg] = argv;
  if (command === 'setup') {
    setup(at);
    console.log(`Record folder ready: ${at.root}`);
    console.log(`Sign in once: CLAUDE_CONFIG_DIR=${at.config} claude, then /login, then exit.`);
    return;
  }
  if (command === 'run') {
    checkVersion(execFileSync('claude', ['--version'], { encoding: 'utf8' }));
    if (!existsSync(at.mcpConfig)) setup(at);
    for (const name of pickRun(arg)) {
      await runScenario(name, at, {
        program: 'claude',
        holdMs: 120_000,
        timeoutMs: 600_000,
        env: process.env,
        log: (line) => console.log(line),
      });
    }
    return;
  }
  if (command === 'reduce') {
    for (const name of pick(arg)) {
      // `reduce all` passes over a scenario not recorded yet; its fixture stays as it is.
      if (arg === 'all' && !existsSync(join(at.raw, name, 'meta.json'))) {
        console.log(`${name}: not recorded, fixture unchanged`);
        continue;
      }
      console.log(await reduceToFixture(name, at, FIXTURES));
    }
    return;
  }
  throw new Error('usage: spike.ts setup | run <scenario|scripted|all> | reduce <scenario|all>');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
