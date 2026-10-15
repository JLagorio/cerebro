// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_VERSION } from './reduce';
import { RECORD_OWED, SCENARIO_NAMES, SCENARIOS } from './spike';

/**
 * The transport facts the D4 record states (M56.1), one case per fact, each
 * reading only the spike fixtures. A fact is pinned the way it was recorded,
 * or, while its live run is owed, the way it was derived from Claude Code
 * 2.1.250's own code: re-recording replaces a derived fixture, and a fact
 * that changed fails here, beside the record's row that must change with it.
 */

const REPO = join(__dirname, '../..');
const SPIKE = join(REPO, 'src-tauri/fixtures/cli-stream/spike');
const RECORD = join(REPO, 'docs/superpowers/specs/2026-10-13-cerebro-m56-d4-transport-record.md');
const SLOW = 'mcp__probe__slow_echo';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

interface Block {
  type: string;
  id?: string;
  name?: string;
  text?: string;
  tool_use_id?: string;
  is_error?: boolean;
  content?: string | Block[];
}

interface Line {
  type?: string;
  attachment?: { type?: string; toolUseID?: string };
  subtype?: string;
  uuid?: string;
  session_id?: string;
  model?: string;
  tools?: string[];
  claude_code_version?: string;
  apiKeySource?: string;
  mcp_servers?: { name: string; status: string }[];
  error?: string;
  is_api_error_message?: boolean;
  effort?: string;
  message?: { id?: string; model?: string; content?: string | Block[]; usage?: Usage };
  is_error?: boolean;
  num_turns?: number;
  result?: string;
  stop_reason?: string | null;
  terminal_reason?: string;
  deferred_tool_use?: { id: string; name: string };
  permission_denials?: { tool_name: string; tool_use_id: string }[];
  usage?: Usage;
  total_cost_usd?: number;
  queued_turn_count?: number;
  request_id?: string;
  request?: { subtype?: string; tool_name?: string; tool_use_id?: string; model?: string };
  response?: {
    subtype?: string;
    request_id?: string;
    response?: {
      behavior?: string;
      commands?: unknown[];
      models?: { value?: string; supportedEffortLevels?: string[] }[];
      current_model?: string;
      still_queued?: unknown[];
    };
  };
}

interface ProbeEntry {
  mode: string;
  arguments?: {
    session_id?: string;
    tool_use_id?: string;
    tool_name?: string;
    tool_input?: string;
  };
  tool_name?: string;
  tool_use_id?: string;
  input?: { tool_name?: string; tool_use_id?: string; file_path?: string };
  answer?: {
    behavior?: string;
    updatedInput?: { answers?: Record<string, string> };
    hookSpecificOutput?: { permissionDecision?: string };
  };
}

interface Step {
  argv: string[];
  exit: { code: number | null; signal: string | null; stopped: boolean };
  stderr: string;
  stdin?: Line[];
  stream: Line[];
  session: { file: string | null; files: string[]; lines: Line[] };
  probe: ProbeEntry[];
}

interface Fixture {
  cli_version: string;
  scenario: string;
  source: 'recorded' | 'derived';
  steps: Step[];
}

function load(name: string): Fixture {
  return JSON.parse(readFileSync(join(SPIKE, `${name}.json`), 'utf8')) as Fixture;
}

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

const ofType = (lines: Line[], type: string) => lines.filter((line) => line.type === type);
const inits = (lines: Line[]) => lines.filter((l) => l.type === 'system' && l.subtype === 'init');
const blocks = (lines: Line[]): Block[] =>
  lines.flatMap((line) => (Array.isArray(line.message?.content) ? line.message.content : []));
const toolUses = (lines: Line[]) =>
  blocks(ofType(lines, 'assistant')).filter((block) => block.type === 'tool_use');
const toolResults = (lines: Line[]) =>
  blocks(ofType(lines, 'user')).filter((block) => block.type === 'tool_result');
const resultFor = (lines: Line[], id: string | undefined) =>
  toolResults(lines).filter((block) => block.tool_use_id === id);
const hooks = (step: Step) => step.probe.filter((entry) => entry.mode === 'hook');
const asked = (step: Step) => step.probe.filter((entry) => entry.mode === 'approve');
const promptTokens = (usage: Usage | undefined) =>
  (usage?.input_tokens ?? 0) +
  (usage?.cache_read_input_tokens ?? 0) +
  (usage?.cache_creation_input_tokens ?? 0);

function textOf(block: Block): string {
  if (typeof block.content === 'string') return block.content;
  return (block.content ?? []).map((inner) => inner.text ?? '').join('');
}

/** The model calls one step made: the first line of each assistant message id. */
function calls(step: Step): Line[] {
  const seen = new Map<string, Line>();
  for (const line of ofType(step.stream, 'assistant')) {
    const id = line.message?.id;
    if (id && !seen.has(id)) seen.set(id, line);
  }
  return [...seen.values()];
}

/** Where the line answering the driver's control request `id` sits in the stream. */
function responseTo(stream: Line[], id: string | undefined): number {
  return stream.findIndex(
    (line) => line.type === 'control_response' && line.response?.request_id === id,
  );
}

function sent(step: Step, subtype: string): Line {
  const line = (step.stdin ?? []).find((l) => l.request?.subtype === subtype);
  if (!line) throw new Error(`the driver sent no ${subtype}`);
  return line;
}

/** Each fact: the claim the record states, and the fixtures its case reads. */
const FACTS: Record<string, { claim: string; fixtures: string[] }> = {
  F0: {
    claim:
      'a fresh config not signed in still starts, then ends in one synthetic authentication_failed reply, a success result with is_error true and terminal_reason api_error, exit 1 and an empty stderr',
    fixtures: ['not-signed-in'],
  },
  F1: {
    claim:
      '--session-id names the session: init reports the minted id and the session file is named for it',
    fixtures: ['not-signed-in', 'resume-usage'],
  },
  F2: {
    claim: '-p --resume keeps the session id and appends to the same session file',
    fixtures: ['resume-usage'],
  },
  F3: {
    claim:
      'each -p turn reports only its own calls: num_turns counts them and result.usage sums their prompt tokens',
    fixtures: ['resume-usage'],
  },
  F4: {
    claim:
      'a PreToolUse defer ends the run as success with stop_reason and terminal_reason tool_deferred, names the call in deferred_tool_use, exits 0 and leaves the tool_use unanswered in the session file, followed by a hook_deferred_tool marker naming it',
    fixtures: ['defer-resume'],
  },
  F5: {
    claim:
      "--resume after a defer runs the hook again on the same call: allow runs it under the original tool_use id, and deny returns the hook's reason as an error result",
    fixtures: ['defer-resume'],
  },
  F6: {
    claim:
      'two calls in one message reach the hook one streamed line each, so each defer writes its own hook_deferred_tool marker and the result names the last; on resume that call runs and the other gets no result',
    fixtures: ['defer-resume'],
  },
  F7: {
    claim: 'a PreToolUse hook from --settings runs under --setting-sources user',
    fixtures: ['defer-resume'],
  },
  F8: {
    claim:
      'the prompt tool is asked with tool_name, input and tool_use_id, its allow applies updatedInput and its deny message reaches the model; without it an ungranted Write is a permission denial',
    fixtures: ['prompt-tool'],
  },
  F9: {
    claim:
      "AskUserQuestion is in init's tools only with a prompt tool, and its answer returns in updatedInput's answers, keyed by question",
    fixtures: ['not-signed-in', 'ask-question'],
  },
  F10: {
    claim: 'an allow rule skips the prompt tool, and a PreToolUse hook still runs before it',
    fixtures: ['allow-rule'],
  },
  F11: {
    claim:
      'initialize answers with commands, models and the current model, and every effort level it lists is low, medium, high, xhigh or max',
    fixtures: ['stream-json'],
  },
  F12: {
    claim: 'a can_use_tool request waits while unanswered and the turn goes on after allow',
    fixtures: ['stream-json'],
  },
  F13: {
    claim:
      'interrupt answers success with still_queued, ends the turn as error_during_execution, and the child takes the next message',
    fixtures: ['stream-json'],
  },
  F14: {
    claim: 'set_model answers success and the next reply comes from the new model',
    fixtures: ['stream-json'],
  },
  F15: {
    claim:
      "a message sent mid-turn waits: the running turn's result counts it in queued_turn_count, and its own result follows",
    fixtures: ['stream-json'],
  },
  F16: {
    claim: 'stream-json gives one result per message, and total_cost_usd only grows across them',
    fixtures: ['stream-json'],
  },
  F17: {
    claim:
      'a stop mid-tool leaves the tool_use unanswered in the session file, and --resume succeeds without writing a result for it',
    fixtures: ['kill-resume'],
  },
  F18: {
    claim: 'a stop mid-text keeps none of the partial reply, and --resume answers anew',
    fixtures: ['kill-resume'],
  },
  F19: {
    claim:
      '--effort takes low, medium, high, xhigh or max, and a resumed turn on sonnet with --effort low records effort low on its reply',
    fixtures: ['resume-usage', 'stream-json'],
  },
};

const title = (id: string) => `${id} ${FACTS[id].claim}`;

/**
 * M57.1's gate facts, read from `defer-gate.json`. That scenario is owed its
 * first live run (RECORD_OWED): until the owner's login records it, there is
 * no fixture, so each case skips under a title that says the run is owed, and
 * M57.1 builds on the claims as derived from the 2.1.250 bundle (the D4
 * record's "M57.1: the gate").
 */
const GATE_FACTS: Record<string, string> = {
  F21: 'an mcp_tool PreToolUse hook calls the named server with the interpolated call, and the text it answers is read as hook JSON',
  F22: 'an empty-prompt resume runs the hook again for the same tool_use id: allow pairs the result with that id and applies updatedInput, and deny returns its reason as the tool result',
  F23: 'a hook that fails or times out leaves the call to argv, which refuses a tool it does not allow',
  F24: 'a message with two calls ignores a defer and writes no hook_deferred_tool marker',
  F25: 'a resume with new text settles a deferred call first, through the hook, then runs the new prompt',
  F26: 'a matcher of names joined by a bar is an exact list: a name it only nearly holds never runs the hook',
  F27: 'the hook reaches a tool the server never lists',
};
const GATE = 'defer-gate';
const gateRecorded = existsSync(join(SPIKE, `${GATE}.json`));
const gateTitle = (id: string) =>
  `${id} ${GATE_FACTS[id]}${gateRecorded ? '' : ' (live run owed)'}`;
const gateCalls = (step: Step) => step.probe.filter((entry) => entry.mode === 'gate');
const deferredId = (step: Step) => ofType(step.stream, 'result')[0]?.deferred_tool_use?.id;
const markers = (lines: Line[]) =>
  lines.filter(
    (line) => line.type === 'attachment' && line.attachment?.type === 'hook_deferred_tool',
  );

describe('the transport facts', () => {
  it(title('F0'), () => {
    const [step] = load('not-signed-in').steps;
    const [init] = inits(step.stream);
    expect(init.mcp_servers).toEqual([{ name: 'probe', status: 'connected' }]);
    const replies = ofType(step.stream, 'assistant');
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      error: 'authentication_failed',
      is_api_error_message: true,
      message: { model: '<synthetic>' },
    });
    const [result] = ofType(step.stream, 'result');
    expect(result).toMatchObject({
      subtype: 'success',
      is_error: true,
      terminal_reason: 'api_error',
    });
    expect(result.result).toBe(blocks(replies)[0].text);
    expect(step.exit).toEqual({ code: 1, signal: null, stopped: false });
    expect(step.stderr).toBe('');
  });

  it(title('F1'), () => {
    const named = FACTS.F1.fixtures.flatMap((name) =>
      load(name).steps.filter((step) => flag(step.argv, '--session-id') !== undefined),
    );
    expect(named.length).toBeGreaterThanOrEqual(2);
    for (const step of named) {
      const id = flag(step.argv, '--session-id');
      expect(inits(step.stream)[0].session_id).toBe(id);
      expect(step.session.file).toBe(`${id}.jsonl`);
    }
  });

  it(title('F2'), () => {
    const { steps } = load('resume-usage');
    for (const [index, step] of steps.entries()) {
      if (index === 0) continue;
      const id = flag(step.argv, '--resume');
      expect(id).toBe(flag(steps[0].argv, '--session-id'));
      expect(inits(step.stream)[0].session_id).toBe(id);
      expect(step.session.files).toEqual([`${id}.jsonl`]);
      const before = steps[index - 1].session.lines.map((line) => line.uuid);
      const after = step.session.lines.map((line) => line.uuid);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.length).toBeGreaterThan(before.length);
    }
  });

  it(title('F3'), () => {
    for (const step of load('resume-usage').steps) {
      const [result] = ofType(step.stream, 'result');
      const own = calls(step);
      expect(result.num_turns).toBe(own.length);
      const sum = own.reduce((total, line) => total + promptTokens(line.message?.usage), 0);
      expect(promptTokens(result.usage)).toBe(sum);
      const buckets = result.usage?.cache_creation;
      expect(
        (buckets?.ephemeral_5m_input_tokens ?? NaN) + (buckets?.ephemeral_1h_input_tokens ?? NaN),
      ).toBe(result.usage?.cache_creation_input_tokens);
    }
  });

  it(title('F4'), () => {
    const [step] = load('defer-resume').steps;
    const [call] = toolUses(step.stream);
    const [result] = ofType(step.stream, 'result');
    expect(result).toMatchObject({
      subtype: 'success',
      is_error: false,
      stop_reason: 'tool_deferred',
      terminal_reason: 'tool_deferred',
      deferred_tool_use: { id: call.id, name: SLOW },
    });
    expect(step.exit.code).toBe(0);
    expect(toolUses(step.session.lines).map((block) => block.id)).toContain(call.id);
    expect(resultFor(step.session.lines, call.id)).toEqual([]);
    const lines = step.session.lines;
    const callAt = lines.findIndex((line) => toolUses([line]).some((b) => b.id === call.id));
    const markerAt = lines.findIndex(
      (line) => markers([line])[0]?.attachment?.toolUseID === call.id,
    );
    expect(markerAt).toBeGreaterThan(callAt);
  });

  it(title('F5'), () => {
    const { steps } = load('defer-resume');
    for (const [deferred, resumed, decision] of [
      [0, 1, 'allow'],
      [2, 3, 'deny'],
    ] as const) {
      const id = ofType(steps[deferred].stream, 'result')[0].deferred_tool_use?.id;
      const [hook] = hooks(steps[resumed]);
      expect(hook.input?.tool_use_id).toBe(id);
      expect(hook.answer?.hookSpecificOutput?.permissionDecision).toBe(decision);
      const [answer] = resultFor(steps[resumed].stream, id);
      if (decision === 'allow') {
        expect(answer.is_error ?? false).toBe(false);
        expect(textOf(answer)).toBe('alpha');
      } else {
        expect(answer.is_error).toBe(true);
        expect(textOf(answer)).toContain('Not today.');
      }
    }
  });

  it(title('F6'), () => {
    // Contested with F24 until the live run: the bundle's solo-only defer
    // check counts the calls in the call's own streamed line, which holds one
    // unless a batch tool decomposes, so this pins the per-line reading.
    const { steps } = load('defer-resume');
    const ids = toolUses(steps[4].stream).map((block) => block.id);
    expect(new Set(calls(steps[4]).map((line) => line.message?.id)).size).toBe(1);
    expect(ids).toHaveLength(2);
    for (const line of ofType(steps[4].stream, 'assistant'))
      expect(toolUses([line])).toHaveLength(1);
    expect(hooks(steps[4]).map((entry) => entry.input?.tool_use_id)).toEqual(ids);
    for (const entry of hooks(steps[4]))
      expect(entry.answer?.hookSpecificOutput?.permissionDecision).toBe('defer');
    const marked = markers(steps[4].session.lines).map((line) => line.attachment?.toolUseID);
    expect(marked).toEqual(ids);
    const named = ofType(steps[4].stream, 'result')[0].deferred_tool_use?.id;
    expect(named).toBe(marked.at(-1));
    expect(hooks(steps[5]).map((entry) => entry.input?.tool_use_id)).toEqual([named]);
    // The model may call again after the resume; the dropped call's own id never gets a result.
    const other = ids.find((id) => id !== named);
    expect(resultFor(steps[5].stream, named)).toHaveLength(1);
    expect(resultFor(steps[5].stream, other)).toEqual([]);
    expect(resultFor(steps[5].session.lines, other)).toEqual([]);
  });

  it(title('F7'), () => {
    const [step] = load('defer-resume').steps;
    expect(flag(step.argv, '--setting-sources')).toBe('user');
    expect(flag(step.argv, '--settings')).toMatch(/settings-hook\.json$/);
    expect(hooks(step).map((entry) => entry.input?.tool_name)).toEqual([SLOW]);
    expect(ofType(step.stream, 'result')[0].stop_reason).toBe('tool_deferred');
  });

  it(title('F8'), () => {
    const [unasked, allowed, denied] = load('prompt-tool').steps;
    expect(flag(unasked.argv, '--permission-prompt-tool')).toBeUndefined();
    expect(asked(unasked)).toEqual([]);
    const denials = ofType(unasked.stream, 'result')[0].permission_denials ?? [];
    expect(denials.map((denial) => denial.tool_name)).toEqual(['Write']);
    const write = (step: Step) => toolUses(step.stream).find((block) => block.name === 'Write');
    for (const step of [allowed, denied]) {
      expect(flag(step.argv, '--permission-prompt-tool')).toBe('mcp__probe__approve');
      const ask = asked(step).find((entry) => entry.tool_name === 'Write');
      expect(ask?.tool_use_id).toBe(write(step)?.id);
      expect(ask?.input?.file_path).toMatch(/notes\/gamma\.md$/);
    }
    const [wrote] = resultFor(allowed.stream, write(allowed)?.id);
    expect(textOf(wrote)).toContain('gamma-approved.md');
    const [refused] = resultFor(denied.stream, write(denied)?.id);
    expect(refused.is_error).toBe(true);
    expect(textOf(refused)).toContain('Not now.');
  });

  it(title('F9'), () => {
    const tools = (step: Step) => inits(step.stream)[0].tools ?? [];
    const [unsigned] = load('not-signed-in').steps;
    const [without, withTool] = load('ask-question').steps;
    expect(tools(unsigned)).not.toContain('AskUserQuestion');
    expect(tools(without)).not.toContain('AskUserQuestion');
    expect(tools(withTool)).toContain('AskUserQuestion');
    const ask = asked(withTool).find((entry) => entry.tool_name === 'AskUserQuestion');
    // Keyed by the question's own text, which the model words.
    expect(Object.values(ask?.answer?.updatedInput?.answers ?? {})).toEqual(['Blue']);
    const call = toolUses(withTool.stream).find((block) => block.name === 'AskUserQuestion');
    expect(ask?.tool_use_id).toBe(call?.id);
    expect(textOf(resultFor(withTool.stream, call?.id)[0])).toContain('Blue');
  });

  it(title('F10'), () => {
    const [ruled, hooked] = load('allow-rule').steps;
    for (const step of [ruled, hooked]) {
      expect(flag(step.argv, '--permission-prompt-tool')).toBe('mcp__probe__approve');
      expect(asked(step)).toEqual([]);
    }
    const call = toolUses(ruled.stream).find((block) => block.name === SLOW);
    expect(textOf(resultFor(ruled.stream, call?.id)[0])).toBe('rule');
    expect(hooks(hooked)).toHaveLength(1);
    expect(ofType(hooked.stream, 'result')[0].stop_reason).toBe('tool_deferred');
  });

  it(title('F11'), () => {
    const [step] = load('stream-json').steps;
    const id = sent(step, 'initialize').request_id;
    const answer = step.stream[responseTo(step.stream, id)].response;
    expect(answer?.subtype).toBe('success');
    expect(Array.isArray(answer?.response?.commands)).toBe(true);
    expect(answer?.response?.models?.length).toBeGreaterThan(0);
    expect(typeof answer?.response?.current_model).toBe('string');
    for (const model of answer?.response?.models ?? []) {
      expect(EFFORTS).toEqual(expect.arrayContaining(model.supportedEffortLevels ?? []));
    }
  });

  it(title('F12'), () => {
    const [step] = load('stream-json').steps;
    const ask = step.stream.find(
      (line) => line.request?.subtype === 'can_use_tool' && line.request.tool_name === SLOW,
    );
    expect(ask).toBeDefined();
    const allow = (step.stdin ?? []).find((line) => line.response?.request_id === ask?.request_id);
    expect(allow?.response?.response?.behavior).toBe('allow');
    const at = step.stream.findIndex(
      (line) => resultFor([line], ask?.request?.tool_use_id).length > 0,
    );
    expect(at).toBeGreaterThan(step.stream.indexOf(ask as Line));
    const next = step.stream.slice(at).find((line) => line.type === 'result');
    expect(next?.subtype).toBe('success');
  });

  it(title('F13'), () => {
    const [step] = load('stream-json').steps;
    const id = sent(step, 'interrupt').request_id;
    const answer = step.stream[responseTo(step.stream, id)].response;
    expect(answer?.subtype).toBe('success');
    expect(Array.isArray(answer?.response?.still_queued)).toBe(true);
    const results = ofType(step.stream, 'result');
    const cut = results.findIndex((line) => line.subtype === 'error_during_execution');
    expect(cut).toBeGreaterThan(-1);
    expect(results[cut + 1]?.subtype).toBe('success');
  });

  it(title('F14'), () => {
    const [step] = load('stream-json').steps;
    const request = sent(step, 'set_model');
    const at = responseTo(step.stream, request.request_id);
    expect(step.stream[at].response?.subtype).toBe('success');
    const next = step.stream.slice(at).find((line) => line.type === 'assistant');
    expect(next?.message?.model).toContain(request.request?.model);
  });

  it(title('F15'), () => {
    const [step] = load('stream-json').steps;
    const results = ofType(step.stream, 'result');
    const waited = results.findIndex((line) => line.queued_turn_count === 1);
    expect(waited).toBeGreaterThan(-1);
    expect(results[waited + 1]?.subtype).toBe('success');
  });

  it(title('F16'), () => {
    const [step] = load('stream-json').steps;
    const results = ofType(step.stream, 'result');
    expect(results).toHaveLength(ofType(step.stdin ?? [], 'user').length);
    const costs = results.map((line) => line.total_cost_usd ?? NaN);
    expect(costs).toEqual([...costs].sort((a, b) => a - b));
  });

  it(title('F17'), () => {
    const [stopped, resumed] = load('kill-resume').steps;
    expect(stopped.exit.stopped).toBe(true);
    const [call] = toolUses(stopped.stream);
    expect(call.name).toBe(SLOW);
    expect(toolUses(stopped.session.lines).map((block) => block.id)).toEqual([call.id]);
    expect(resultFor(stopped.session.lines, call.id)).toEqual([]);
    expect(flag(resumed.argv, '--resume')).toBe(flag(stopped.argv, '--session-id'));
    expect(ofType(resumed.stream, 'result')[0]).toMatchObject({
      subtype: 'success',
      is_error: false,
    });
    expect(resultFor(resumed.stream, call.id)).toEqual([]);
    expect(resultFor(resumed.session.lines, call.id)).toEqual([]);
  });

  it(title('F18'), () => {
    const [, , stopped, resumed] = load('kill-resume').steps;
    expect(stopped.exit.stopped).toBe(true);
    expect(ofType(stopped.stream, 'assistant')).toEqual([]);
    expect(ofType(stopped.session.lines, 'assistant')).toEqual([]);
    expect(ofType(resumed.stream, 'result')[0]).toMatchObject({
      subtype: 'success',
      is_error: false,
    });
    expect(blocks(ofType(resumed.stream, 'assistant')).some((b) => b.type === 'text')).toBe(true);
  });

  it(title('F19'), () => {
    const { steps } = load('resume-usage');
    const step = steps[2];
    expect(flag(step.argv, '--effort')).toBe('low');
    expect(flag(step.argv, '--model')).toBe('sonnet');
    const before = new Set(steps[1].session.lines.map((line) => line.uuid));
    const replies = ofType(step.session.lines, 'assistant').filter((l) => !before.has(l.uuid));
    expect(replies.length).toBeGreaterThan(0);
    for (const reply of replies) expect(reply.effort).toBe('low');
    const [stream] = load('stream-json').steps;
    const initialize =
      stream.stream[responseTo(stream.stream, sent(stream, 'initialize').request_id)];
    for (const model of initialize.response?.response?.models ?? []) {
      for (const level of model.supportedEffortLevels ?? []) expect(EFFORTS).toContain(level);
    }
  });

  it.skipIf(!gateRecorded)(gateTitle('F21'), () => {
    const [step] = load(GATE).steps;
    const id = deferredId(step);
    const [call] = gateCalls(step);
    expect(call.arguments?.tool_use_id).toBe(id);
    expect(call.arguments?.tool_name).toBe(SLOW);
    expect(JSON.parse(call.arguments?.tool_input ?? 'null')).toMatchObject({ text: 'alpha' });
    expect(ofType(step.stream, 'result')[0].stop_reason).toBe('tool_deferred');
    expect(markers(step.session.lines).map((line) => line.attachment?.toolUseID)).toEqual([id]);
  });

  it.skipIf(!gateRecorded)(gateTitle('F22'), () => {
    const { steps } = load(GATE);
    for (const [deferred, resumed] of [
      [0, 1],
      [2, 3],
    ] as const) {
      const id = deferredId(steps[deferred]);
      expect(steps[resumed].argv[1]).toBe('');
      expect(gateCalls(steps[resumed]).map((call) => call.arguments?.tool_use_id)).toContain(id);
      const [answer] = resultFor(steps[resumed].stream, id);
      if (resumed === 1) {
        expect(answer.is_error ?? false).toBe(false);
        expect(textOf(answer)).toBe('gamma');
      } else {
        expect(answer.is_error).toBe(true);
        expect(textOf(answer)).toContain('Not today.');
      }
    }
  });

  it.skipIf(!gateRecorded)(gateTitle('F23'), () => {
    const step = load(GATE).steps[4];
    expect(gateCalls(step)).not.toHaveLength(0);
    const [call] = toolUses(step.stream);
    const [answer] = resultFor(step.stream, call.id);
    expect(answer.is_error).toBe(true);
    expect(textOf(answer)).not.toContain('delta');
    expect(ofType(step.stream, 'result')[0].stop_reason).not.toBe('tool_deferred');
  });

  it.skipIf(!gateRecorded)(gateTitle('F24'), () => {
    const step = load(GATE).steps[5];
    expect(toolUses(step.stream)).toHaveLength(2);
    expect(new Set(calls(step).map((line) => line.message?.id)).size).toBe(1);
    expect(ofType(step.stream, 'result')[0].deferred_tool_use).toBeUndefined();
    expect(markers(step.session.lines)).toEqual([]);
  });

  it.skipIf(!gateRecorded)(gateTitle('F25'), () => {
    const { steps } = load(GATE);
    const id = deferredId(steps[6]);
    const [settled] = resultFor(steps[7].stream, id);
    expect(settled.is_error).toBe(true);
    expect(textOf(settled)).toContain('Never answered.');
    const lines = steps[7].session.lines;
    const answeredAt = lines.findIndex((line) =>
      toolResults([line]).some((block) => block.tool_use_id === id),
    );
    const promptAt = lines.findIndex(
      (line) => line.type === 'user' && line.message?.content === 'Reply with the one word: next.',
    );
    expect(answeredAt).toBeGreaterThan(-1);
    expect(promptAt).toBeGreaterThan(answeredAt);
    expect(ofType(steps[7].stream, 'result')[0].result).toMatch(/next/i);
  });

  it.skipIf(!gateRecorded)(gateTitle('F26'), () => {
    const step = load(GATE).steps[8];
    expect(flag(step.argv, '--settings')).toMatch(/settings-gate-near\.json$/);
    expect(gateCalls(step)).toEqual([]);
    expect(ofType(step.stream, 'result')[0].stop_reason).not.toBe('tool_deferred');
  });

  it.skipIf(!gateRecorded)(gateTitle('F27'), () => {
    const [step] = load(GATE).steps;
    const [init] = inits(step.stream);
    expect(init.tools).not.toContain('mcp__probe__gate');
    expect(gateCalls(step)).not.toHaveLength(0);
  });

  it(`every init reads ${CLI_VERSION} and names no API-key source`, () => {
    for (const name of SCENARIO_NAMES) {
      if (RECORD_OWED.includes(name) && !existsSync(join(SPIKE, `${name}.json`))) continue;
      const fixture = load(name);
      expect(fixture.cli_version).toBe(CLI_VERSION);
      const found = fixture.steps.flatMap((step) => inits(step.stream));
      expect(found.length, name).toBeGreaterThan(0);
      for (const init of found) {
        expect(init.claude_code_version, name).toBe(CLI_VERSION);
        expect(init.apiKeySource, name).toBe('none');
      }
    }
  });
});

/** The record's fact table, row by row: claim, status and the fixtures it cites. */
function factTable(
  markdown: string,
): Map<string, { claim: string; status: string; fixtures: string[] }> {
  const rows = new Map<string, { claim: string; status: string; fixtures: string[] }>();
  for (const line of markdown.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    if (!/^F\d+$/.test(cells[1] ?? '')) continue;
    rows.set(cells[1], {
      claim: cells[2],
      status: cells[3],
      fixtures: [...cells[4].matchAll(/spike\/([\w-]+)\.json/g)].map((match) => match[1]),
    });
  }
  return rows;
}

describe('the D4 record', () => {
  const rows = factTable(readFileSync(RECORD, 'utf8'));

  it('states every fact as its case is titled, citing the fixtures the case reads', () => {
    for (const [id, fact] of Object.entries(FACTS)) {
      expect(rows.get(id)?.claim, id).toBe(fact.claim);
      expect(rows.get(id)?.fixtures, id).toEqual(fact.fixtures);
    }
  });

  it('calls a fact measured only on a recorded fixture, and owed while one is derived', () => {
    for (const [id, fact] of Object.entries(FACTS)) {
      const sources = fact.fixtures.map((name) => load(name).source);
      const status = rows.get(id)?.status ?? '';
      expect(status.startsWith('measured'), `${id}: ${status}`).toBe(sources.includes('recorded'));
      expect(status.includes('owed'), `${id}: ${status}`).toBe(sources.includes('derived'));
    }
  });

  it('states the gate facts in their own section, owed until recorded (M57.1)', () => {
    const record = readFileSync(RECORD, 'utf8');
    expect(record).toContain('## M57.1: the gate');
    for (const [id, claim] of Object.entries(GATE_FACTS)) {
      const row = rows.get(id);
      expect(row?.claim, id).toBe(claim);
      expect(row?.fixtures, id).toEqual([GATE]);
      const source = gateRecorded ? load(GATE).source : 'derived';
      expect(row?.status.startsWith('measured'), `${id}: ${row?.status}`).toBe(
        source === 'recorded',
      );
      expect(row?.status.includes('owed'), `${id}: ${row?.status}`).toBe(source === 'derived');
    }
    expect([...(SCENARIOS[GATE].facts as string[])]).toEqual(Object.keys(GATE_FACTS));
  });

  it('cites, for each fact, exactly the scenarios the driver says answer it', () => {
    for (const [id, fact] of Object.entries(FACTS)) {
      const answering = SCENARIO_NAMES.filter((name) =>
        (SCENARIOS[name].facts as string[]).includes(id),
      );
      expect([...fact.fixtures].sort(), id).toEqual([...answering].sort());
    }
  });
});
