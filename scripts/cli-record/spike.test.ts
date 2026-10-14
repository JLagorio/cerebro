// @vitest-environment node
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AUTH_VARS,
  checkVersion,
  childEnv,
  CLI_VERSION,
  findSessionFile,
  layout,
  lineMatches,
  machine,
  pick,
  readRaw,
  recordRoot,
  reduceToFixture,
  refuseRoot,
  REPO_SELECTING_VARS,
  runChild,
  runScenario,
  SCENARIO_NAMES,
  SCENARIOS,
  sessionFiles,
  setup,
  stopGroup,
  streamArgv,
  turnArgv,
  type RunOptions,
  type Turn,
} from './spike';

const REPO = join(__dirname, '../..');
const PLACEHOLDER = layout('/RECORD');

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

/**
 * A stand-in for `claude`: it prints the 2.1.250 line shapes the driver
 * reacts to, writes a session file under CLAUDE_CONFIG_DIR, and speaks
 * enough of the stream-json control protocol to run the whole script.
 */
const FAKE = `#!${process.execPath}
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const flag = (name) => { const at = argv.indexOf(name); return at === -1 ? undefined : argv[at + 1]; };
const out = (line) => process.stdout.write(JSON.stringify(line) + '\\n');
if (argv[0] === '--version') { process.stdout.write('2.1.250 (Claude Code)\\n'); process.exit(0); }
if (process.env.FAKE_IGNORE_TERM) process.on('SIGTERM', () => {});
const session = flag('--session-id') ?? flag('--resume');
const folder = join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-fake-vault');
mkdirSync(folder, { recursive: true });
const record = (line) => appendFileSync(join(folder, session + '.jsonl'), JSON.stringify({ sessionId: session, ...line }) + '\\n');
const init = () => out({ type: 'system', subtype: 'init', session_id: session, claude_code_version: '2.1.250', apiKeySource: 'none', mcp_servers: [{ name: 'probe', status: 'connected' }], key: process.env.ANTHROPIC_API_KEY ?? null });
const reply = (text) => {
  out({ type: 'assistant', session_id: session, message: { id: 'msg_01Fake', content: [{ type: 'text', text }] } });
  record({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
};
const result = (extra = {}) => out({ type: 'result', subtype: 'success', is_error: false, session_id: session, ...extra });
const hang = () => setInterval(() => {}, 1000);

if (argv.includes('--input-format')) {
  let started = false;
  let onAllow = null;
  let whenNext = null;
  createInterface({ input: process.stdin }).on('line', (text) => {
    const line = JSON.parse(text);
    if (line.type === 'control_request') {
      const interrupt = line.request.subtype === 'interrupt';
      out({ type: 'control_response', response: { subtype: 'success', request_id: line.request_id, response: interrupt ? { still_queued: [] } : {} } });
      if (interrupt) result({ subtype: 'error_during_execution', is_error: true });
      return;
    }
    if (line.type === 'control_response') { const run = onAllow; onAllow = null; run?.(); return; }
    if (!started) { started = true; init(); }
    if (whenNext) { const run = whenNext; whenNext = null; run(); }
    const said = line.message.content[0].text;
    record({ type: 'user', message: { content: said } });
    if (said.includes('slow_echo')) {
      out({ type: 'control_request', request_id: 'ask-' + said.length, request: { subtype: 'can_use_tool', tool_name: 'mcp__probe__slow_echo', input: { text: 'x' }, tool_use_id: 'toolu_01Fake' } });
      onAllow = said.includes('seconds 20') ? () => { whenNext = () => result({ queued_turn_count: 1 }); } : () => { reply('done'); result(); };
      return;
    }
    if (said.includes('story')) { out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Once' } } }); return; }
    reply(said);
    result();
  }).on('close', () => process.exit(0));
} else {
  init();
  record({ type: 'user', message: { content: argv[1] } });
  if (process.env.FAKE_SIGNED_OUT) {
    out({ type: 'assistant', error: 'authentication_failed', message: { model: '<synthetic>', content: [{ type: 'text', text: 'Not logged in' }] } });
    result({ is_error: true });
    process.exit(1);
  }
  if (argv[1].includes('seconds 30')) {
    out({ type: 'assistant', session_id: session, message: { id: 'msg_01Fake', content: [{ type: 'tool_use', id: 'toolu_01Fake', name: 'mcp__probe__slow_echo', input: { text: 'stop', seconds: 30 } }] } });
    hang();
  } else if (argv[1].includes('story')) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'A' } } });
    hang();
  } else {
    reply(process.env.FAKE_REPLY ?? 'ok');
    result();
  }
}
`;

describe('the record folder', () => {
  it('is CEREBRO_RECORD_DIR, else <tmpdir>/cerebro-cli-record', () => {
    expect(recordRoot({ CEREBRO_RECORD_DIR: '/tmp/rec' }, '/var/t')).toBe('/tmp/rec');
    expect(recordRoot({ CEREBRO_RECORD_DIR: ' ' }, '/var/t')).toBe('/var/t/cerebro-cli-record');
    expect(recordRoot({}, '/var/t')).toBe('/var/t/cerebro-cli-record');
  });

  it('may not sit inside the repo or under ~/.claude', () => {
    const places = { repo: '/Users/x/dev/cerebro', home: '/Users/x' };
    expect(refuseRoot('/Users/x/dev/cerebro', places)).toMatch(/inside the repo/);
    expect(refuseRoot('/Users/x/dev/cerebro/tmp/rec', places)).toMatch(/inside the repo/);
    expect(refuseRoot('/Users/x/.claude/rec', places)).toMatch(/under ~\/\.claude/);
    expect(refuseRoot('/Users/x/dev/cerebro-records', places)).toBeNull();
    expect(refuseRoot('/var/folders/ab/T/cerebro-cli-record', places)).toBeNull();
  });
});

describe('checkVersion', () => {
  it(`takes ${CLI_VERSION} and refuses any other version`, () => {
    expect(checkVersion('2.1.250 (Claude Code)\n')).toBe('2.1.250');
    expect(() => checkVersion('2.1.251 (Claude Code)')).toThrow(/2\.1\.251 is installed/);
    expect(() => checkVersion('')).toThrow(/unknown version/);
  });
});

describe('childEnv', () => {
  it('drops the credentials, the git variables and a parent session, and sets the config', () => {
    const parent = {
      PATH: '/usr/bin',
      HOME: '/Users/x',
      ANTHROPIC_API_KEY: 'k',
      ANTHROPIC_AUTH_TOKEN: 't',
      CLAUDE_CODE_OAUTH_TOKEN: 'o',
      ANTHROPIC_BASE_URL: 'u',
      GIT_DIR: '/repo/.git',
      GIT_WORK_TREE: '/repo',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
      CLAUDE_EFFORT: 'high',
      CLAUDE_CONFIG_DIR: '/Users/x/.claude',
    };
    const env = childEnv(parent, '/var/rec/claude-config');
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/Users/x',
      CLAUDE_CONFIG_DIR: '/var/rec/claude-config',
    });
    for (const name of [...AUTH_VARS, ...REPO_SELECTING_VARS]) expect(env).not.toHaveProperty(name);
  });

  it('scrubs exactly the variables spawn.rs scrubs', () => {
    const rust = readFileSync(join(REPO, 'src-tauri/src/spawn.rs'), 'utf8');
    const body = /REPO_SELECTING_VARS: &\[&str\] = &\[([^\]]*)\]/.exec(rust)?.[1] ?? '';
    expect(REPO_SELECTING_VARS).toEqual([...body.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]));
  });
});

describe('argv', () => {
  const turns = SCENARIO_NAMES.flatMap((name) => SCENARIOS[name].turns as Turn[]);

  it("carries build_args' shared flags on every turn, on haiku unless a turn says", () => {
    for (const turn of turns) {
      const argv = turnArgv(turn, PLACEHOLDER, 'S');
      expect(argv.slice(0, 16)).toEqual([
        '-p',
        turn.prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--mcp-config',
        '/RECORD/probe/mcp-config.json',
        '--permission-mode',
        turn.mode,
        '--allowedTools',
        turn.allowed.join(','),
        '--setting-sources',
        'user',
        '--strict-mcp-config',
        argv[15],
      ]);
      expect(flag(argv, '--model')).toBe(turn.model ?? 'haiku');
    }
  });

  it('names the prompt tool only where the scenario does', () => {
    for (const turn of turns) {
      const argv = turnArgv(turn, PLACEHOLDER, 'S');
      expect(flag(argv, '--permission-prompt-tool')).toBe(
        turn.promptTool ? 'mcp__probe__approve' : undefined,
      );
    }
    expect(flag(streamArgv(PLACEHOLDER, 'S'), '--permission-prompt-tool')).toBe('stdio');
  });

  it('mints with --session-id and continues with --resume', () => {
    const [first, second] = SCENARIOS['resume-usage'].turns;
    expect(flag(turnArgv(first, PLACEHOLDER, 'S'), '--session-id')).toBe('S');
    expect(turnArgv(first, PLACEHOLDER, 'S')).not.toContain('--resume');
    expect(flag(turnArgv(second, PLACEHOLDER, 'S'), '--resume')).toBe('S');
    expect(turnArgv(second, PLACEHOLDER, 'S')).not.toContain('--session-id');
  });

  it("is each spike fixture's argv, turn for turn", () => {
    for (const name of SCENARIO_NAMES) {
      const fixture = JSON.parse(
        readFileSync(join(REPO, `src-tauri/fixtures/cli-stream/spike/${name}.json`), 'utf8'),
      ) as { steps: { argv: string[] }[] };
      const scenario = SCENARIOS[name];
      const turns = scenario.turns as Turn[];
      expect(fixture.steps).toHaveLength('stream' in scenario ? 1 : turns.length);
      for (const [index, step] of fixture.steps.entries()) {
        const id = flag(step.argv, '--session-id') ?? flag(step.argv, '--resume') ?? '';
        const expected =
          'stream' in scenario
            ? streamArgv(PLACEHOLDER, id)
            : turnArgv(turns[index], PLACEHOLDER, id);
        expect(step.argv, `${name} step ${index}`).toEqual(expected);
      }
    }
  });
});

describe('pick', () => {
  it('names one scenario, or all of them, and nothing else', () => {
    expect(pick('kill-resume')).toEqual(['kill-resume']);
    expect(pick('all')).toEqual(SCENARIO_NAMES);
    for (const bad of [undefined, 'constructor', 'nope'])
      expect(() => pick(bad)).toThrow(/Name a scenario/);
  });
});

describe('runChild', () => {
  it('keeps a last line that has no newline', async () => {
    const run = await runChild({
      program: process.execPath,
      argv: ['-e', 'process.stdout.write(JSON.stringify({ type: "result" }))'],
      env: { PATH: process.env.PATH ?? '' },
      cwd: tmpdir(),
      timeoutMs: 20_000,
    });
    expect(run.stdout).toEqual(['{"type":"result"}']);
    expect(run.exit).toEqual({ code: 0, signal: null, stopped: false });
  });
});

describe('lineMatches', () => {
  it('knows each line the driver waits for', () => {
    expect(lineMatches({ type: 'system', subtype: 'init' }, 'init')).toBe(true);
    expect(lineMatches({ type: 'result' }, 'result')).toBe(true);
    const call = { type: 'assistant', message: { content: [{ type: 'tool_use' }] } };
    expect(lineMatches(call, 'tool_use')).toBe(true);
    expect(lineMatches({ type: 'assistant', message: { content: [] } }, 'tool_use')).toBe(false);
    const delta = {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta' } },
    };
    expect(lineMatches(delta, 'text_delta')).toBe(true);
    const ask = { type: 'control_request', request: { subtype: 'can_use_tool' } };
    expect(lineMatches(ask, 'can_use_tool')).toBe(true);
    const answer = { type: 'control_response', response: { request_id: 'req_2' } };
    expect(lineMatches(answer, 'response', 'req_2')).toBe(true);
    expect(lineMatches(answer, 'response', 'req_1')).toBe(false);
    expect(lineMatches('nope', 'result')).toBe(false);
  });
});

describe('stopGroup', () => {
  const exitedAfter = (exits: boolean) => vi.fn(async () => exits);

  it("refuses group 1 and below, and the driver's own group", async () => {
    const deps = { kill: vi.fn(), exited: exitedAfter(true) };
    await expect(stopGroup(1, 500, deps)).rejects.toThrow(/process group 1/);
    await expect(stopGroup(0, 500, deps)).rejects.toThrow(/process group 0/);
    await expect(stopGroup(-4, 500, deps)).rejects.toThrow(/process group -4/);
    await expect(stopGroup(500, 500, deps)).rejects.toThrow(/own process group/);
    expect(deps.kill).not.toHaveBeenCalled();
  });

  it('sends TERM to the group, then KILL once the grace passes without an exit', async () => {
    const kill = vi.fn();
    expect(await stopGroup(4321, 500, { kill, exited: exitedAfter(true) })).toBe('term');
    expect(kill.mock.calls).toEqual([[-4321, 'SIGTERM']]);
    kill.mockClear();
    const exited = exitedAfter(false);
    expect(await stopGroup(4321, 500, { kill, exited, graceMs: 7 })).toBe('kill');
    expect(kill.mock.calls).toEqual([
      [-4321, 'SIGTERM'],
      [-4321, 'SIGKILL'],
    ]);
    expect(exited).toHaveBeenCalledWith(7);
  });

  it('takes a group already gone as stopped, and passes any other error on', async () => {
    const gone = Object.assign(new Error('gone'), { code: 'ESRCH' });
    const kill = vi.fn(() => {
      throw gone;
    });
    expect(await stopGroup(4321, 500, { kill, exited: exitedAfter(false) })).toBe('kill');
    const denied = vi.fn(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    });
    await expect(stopGroup(4321, 500, { kill: denied, exited: exitedAfter(true) })).rejects.toThrow(
      'denied',
    );
  });
});

describe('session files', () => {
  let projects: string;
  beforeAll(() => {
    projects = mkdtempSync(join(tmpdir(), 'spike-projects-'));
    mkdirSync(join(projects, '-any-slug-at-all'), { recursive: true });
    mkdirSync(join(projects, '-another'), { recursive: true });
    writeFileSync(join(projects, '-any-slug-at-all', 'abc.jsonl'), '');
    writeFileSync(join(projects, '-another', 'def.jsonl'), '');
    writeFileSync(join(projects, 'stray.jsonl'), '');
  });
  afterAll(() => rmSync(projects, { recursive: true, force: true }));

  it('are found by <id>.jsonl under any project folder, never by the slug', () => {
    expect(findSessionFile(projects, 'abc')).toBe(join(projects, '-any-slug-at-all', 'abc.jsonl'));
    expect(findSessionFile(projects, 'stray')).toBeNull();
    expect(findSessionFile(join(projects, 'missing'), 'abc')).toBeNull();
    expect(sessionFiles(projects)).toEqual(['abc.jsonl', 'def.jsonl']);
    expect(sessionFiles(join(projects, 'missing'))).toEqual([]);
  });
});

describe('a recording against a stand-in claude', () => {
  let root: string;
  let program: string;
  let at: ReturnType<typeof layout>;
  const options = (env: NodeJS.ProcessEnv = {}): RunOptions => ({
    program,
    holdMs: 5,
    settleMs: 5,
    graceMs: 300,
    timeoutMs: 20_000,
    env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'never-passed', ...env },
    log: () => {},
  });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'spike-record-'));
    program = join(root, 'fake-claude.mjs');
    writeFileSync(program, FAKE);
    chmodSync(program, 0o755);
    at = layout(join(root, 'record'));
    setup(at);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('sets up the toy vault, the probe server and the three settings files', () => {
    expect(readFileSync(join(at.vault, 'notes/alpha.md'), 'utf8')).toContain('# Alpha');
    const config = JSON.parse(readFileSync(at.mcpConfig, 'utf8'));
    expect(config.mcpServers.probe.args).toEqual([
      join(REPO, 'scripts/cli-record/probe.ts'),
      'server',
      '--dir',
      at.probe,
    ]);
    const hook = JSON.parse(readFileSync(at.settings.hook, 'utf8'));
    expect(hook.hooks.PreToolUse[0].matcher).toBe('mcp__probe__slow_echo');
    expect(hook.hooks.PreToolUse[0].hooks[0].command).toContain("'hook' '--dir'");
    expect(JSON.parse(readFileSync(at.settings.allow, 'utf8'))).toEqual({
      permissions: { allow: ['mcp__probe__slow_echo'] },
    });
    expect(Object.keys(JSON.parse(readFileSync(at.settings['allow-hook'], 'utf8')))).toEqual([
      'permissions',
      'hooks',
    ]);
  });

  it('records each turn: minted first, resumed after, the session file copied', async () => {
    await runScenario('resume-usage', at, options());
    const raw = readRaw(join(at.raw, 'resume-usage'));
    expect(raw.cli_version).toBe(CLI_VERSION);
    expect(raw.steps).toHaveLength(3);
    const id = flag(raw.steps[0].argv, '--session-id');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(raw.steps.slice(1).map((step) => flag(step.argv, '--resume'))).toEqual([id, id]);
    expect(raw.steps.map((step) => step.session.file)).toEqual(Array(3).fill(`${id}.jsonl`));
    expect(raw.steps[2].session.lines).toHaveLength(6);
    const init = JSON.parse(raw.steps[0].stdout[0]);
    expect(init.key).toBeNull();
    expect(raw.steps[0].exit).toEqual({ code: 0, signal: null, stopped: false });
    const timing = JSON.parse(readFileSync(join(at.raw, 'resume-usage/0.timing.json'), 'utf8'));
    expect(timing.init_ms).toBeGreaterThanOrEqual(0);
  });

  it('writes each turn its decision files before it runs', async () => {
    await runScenario('prompt-tool', at, options());
    const decisions = JSON.parse(readFileSync(join(at.probe, 'decisions.json'), 'utf8'));
    expect(decisions).toEqual({ Write: { behavior: 'deny', message: 'Not now.' } });
  });

  it('stops the group at the line a turn names', async () => {
    await runScenario('kill-resume', at, options());
    const raw = readRaw(join(at.raw, 'kill-resume'));
    expect(raw.steps.map((step) => step.exit.stopped)).toEqual([true, false, true, false]);
    expect(raw.steps[0].exit.signal).toBe('SIGTERM');
  });

  it('kills a child that ignores TERM once the grace passes', async () => {
    const run = await runChild({
      program,
      argv: turnArgv(SCENARIOS['kill-resume'].turns[0], at, 'stuck'),
      env: { ...childEnv({ PATH: process.env.PATH }, at.config), FAKE_IGNORE_TERM: '1' },
      cwd: at.vault,
      stopOn: 'tool_use',
      graceMs: 200,
      timeoutMs: 20_000,
    });
    expect(run.exit).toEqual({ code: null, signal: 'SIGKILL', stopped: true });
  });

  it('stops a child that outlives its timeout', async () => {
    const run = await runChild({
      program,
      argv: turnArgv(SCENARIOS['kill-resume'].turns[2], at, 'slow'),
      env: childEnv({ PATH: process.env.PATH }, at.config),
      cwd: at.vault,
      graceMs: 200,
      timeoutMs: 300,
    });
    expect(run.exit.stopped).toBe(true);
    expect(run.timing.first_delta_ms).not.toBeNull();
  });

  it('drives the stream-json child through its whole script', async () => {
    await runScenario('stream-json', at, options());
    const [step] = readRaw(join(at.raw, 'stream-json')).steps;
    const sent = step.stdin.map((line) => JSON.parse(line));
    expect(
      sent.filter((line) => line.type === 'control_request').map((line) => line.request.subtype),
    ).toEqual(['initialize', 'set_model', 'interrupt', 'mcp_status']);
    expect(sent.filter((line) => line.type === 'control_response')).toHaveLength(2);
    const lines = step.stdout.map((line) => JSON.parse(line));
    expect(lines.filter((line) => line.type === 'result')).toHaveLength(6);
    expect(step.exit).toEqual({ code: 0, signal: null, stopped: false });
  });

  it('stops a signed-in scenario at its first unsigned turn, naming the owner step', async () => {
    await expect(runScenario('allow-rule', at, options({ FAKE_SIGNED_OUT: '1' }))).rejects.toThrow(
      /CLAUDE_CONFIG_DIR=<record>\/claude-config claude/,
    );
  });

  it('records not-signed-in in a config made fresh for each run', async () => {
    mkdirSync(at.unsigned, { recursive: true });
    writeFileSync(join(at.unsigned, 'left-over.json'), '{}');
    await runScenario('not-signed-in', at, options({ FAKE_SIGNED_OUT: '1' }));
    expect(existsSync(join(at.unsigned, 'left-over.json'))).toBe(false);
    const [step] = readRaw(join(at.raw, 'not-signed-in')).steps;
    expect(step.exit.code).toBe(1);
    expect(sessionFiles(join(at.unsigned, 'projects'))).toEqual([step.session.file]);
  });

  it('reduces a recording into its fixture, and writes nothing past a scan hit', async () => {
    const out = join(root, 'fixtures');
    const path = await reduceToFixture('resume-usage', at, out);
    const fixture = JSON.parse(readFileSync(path, 'utf8'));
    expect(fixture.source).toBe('recorded');
    expect(flag(fixture.steps[0].argv, '--session-id')).toBe(
      '00000000-0000-4000-8000-000000000001',
    );
    expect(fixture.steps[0].argv).toContain('/RECORD/probe/mcp-config.json');

    await runScenario('ask-question', at, options({ FAKE_REPLY: 'write to someone@example.com' }));
    await expect(reduceToFixture('ask-question', at, out)).rejects.toThrow(
      /an email or other @-address/,
    );
    expect(existsSync(join(out, 'ask-question.json'))).toBe(false);
  });

  it('names what this machine would leak', () => {
    const found = machine(at);
    expect(found.recordDir).toBe(at.root);
    expect(found.repo).toBe(REPO);
    expect(found.user.length).toBeGreaterThan(0);
  });
});
