// The spike's toy MCP server and PreToolUse hook (M56.1).
//
// Claude Code starts this file itself, from the record folder's mcp-config
// and settings, so it uses `node:` imports and erasable TypeScript only:
// plain node 26 strips the types and runs it with nothing to install or build.
//
//   node scripts/cli-record/probe.ts server --dir <record>/probe
//   node scripts/cli-record/probe.ts hook --dir <record>/probe   (PreToolUse input on stdin)
//
// Mode `server` speaks newline-delimited JSON-RPC on stdio as the MCP server
// `probe`, with two tools: `slow_echo` waits, then returns its text, and
// `approve` is the permission prompt tool (`--permission-prompt-tool
// mcp__probe__approve`), which logs what Claude Code asked and answers from
// `decisions.json`, deny by default. Mode `hook` answers a PreToolUse hook
// from `hook-decisions.json`, allow by default. Both append what they saw to
// `log.jsonl` in the same folder, which the driver splits per step.
//
// M57.1 adds a third tool to the server, `gate`, which `tools/list` never
// names: the target of an `mcp_tool` PreToolUse hook (the defer-gate
// scenario), as Cerebro's `ask_gate` is. It answers hook JSON as its text,
// from `gate-decisions.json` by tool name, and `{}` (no opinion) by default.

import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

type JsonObject = Record<string, unknown>;

/** What the server reads and writes, injected so `handleRpc` stays pure. */
export interface ProbeIo {
  /** `decisions.json`, read again on every call so a step can change it. */
  decisions(): JsonObject;
  /** `gate-decisions.json` (M57.1), read the same way; absent reads empty. */
  gateDecisions?(): JsonObject;
  log(entry: JsonObject): void;
  sleep(ms: number): Promise<void>;
}

export interface RpcReply {
  jsonrpc: '2.0';
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export type Decision =
  { behavior: 'allow'; updatedInput: JsonObject } | { behavior: 'deny'; message: string };

export const SERVER_NAME = 'probe';
/** The hook endpoint (M57.1): served, and never listed. */
export const GATE_TOOL = 'gate';
export const MAX_SECONDS = 60;
/** The version Claude Code 2.1.250 offers when a client names none. */
const FALLBACK_PROTOCOL = '2025-06-18';
const HOOK_DECISIONS = ['allow', 'deny', 'ask', 'defer'];

// M54.1's key: a tool that sets it loads with the run, so the model calls it
// without a ToolSearch hop first.
const ALWAYS_LOAD = { 'anthropic/alwaysLoad': true };

export const TOOLS = [
  {
    name: 'slow_echo',
    description: `Wait the given number of seconds (0 to ${MAX_SECONDS}), then return the text unchanged.`,
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to return.' },
        seconds: {
          type: 'number',
          minimum: 0,
          maximum: MAX_SECONDS,
          description: 'How long to wait before returning.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    _meta: ALWAYS_LOAD,
  },
  {
    name: 'approve',
    description:
      'Answer allow or deny for a tool call. Claude Code calls this; the model never does.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string' },
        input: { type: 'object' },
        tool_use_id: { type: 'string' },
      },
      required: ['tool_name', 'input'],
    },
    _meta: ALWAYS_LOAD,
  },
];

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reply(id: unknown, result: unknown): RpcReply {
  return { jsonrpc: '2.0', id, result };
}

function failure(id: unknown, code: number, message: string): RpcReply {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function text(value: string, isError = false): JsonObject {
  return { content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) };
}

/**
 * The prompt tool's answer for one call. A decision's `updatedInput` is a
 * patch over the call's own input, and `answer` fills AskUserQuestion's
 * `answers`, keyed by each question's text, with that one label. Anything
 * else, a missing entry included, denies.
 */
export function decide(toolName: string, input: JsonObject, decisions: JsonObject): Decision {
  const entry = decisions[toolName];
  if (!isObject(entry) || entry.behavior !== 'allow') {
    const message =
      isObject(entry) && entry.behavior === 'deny' && typeof entry.message === 'string'
        ? entry.message
        : `The probe holds no decision for ${toolName}, so it denies.`;
    return { behavior: 'deny', message };
  }
  const updatedInput: JsonObject = {
    ...input,
    ...(isObject(entry.updatedInput) ? entry.updatedInput : {}),
  };
  if (typeof entry.answer === 'string' && Array.isArray(input.questions)) {
    const answers: JsonObject = {};
    for (const question of input.questions) {
      if (isObject(question) && typeof question.question === 'string') {
        answers[question.question] = entry.answer;
      }
    }
    updatedInput.answers = answers;
  }
  return { behavior: 'allow', updatedInput };
}

/**
 * The gate's answer for one hook call (M57.1): the hook JSON its tool's entry
 * in `decisions` names, as the text Claude Code reads, or `{}` (no opinion)
 * when there is none. An entry with `isError` answers as a failed tool, which
 * a hook treats as no answer at all. `updatedInput` rides an allow.
 */
export function gateAnswer(args: JsonObject, decisions: JsonObject): JsonObject {
  const toolName = typeof args.tool_name === 'string' ? args.tool_name : '';
  const entry = decisions[toolName];
  if (!isObject(entry)) return text('{}');
  if (entry.isError === true) return text('The probe gate failed on purpose.', true);
  const decision = HOOK_DECISIONS.includes(String(entry.permissionDecision))
    ? String(entry.permissionDecision)
    : null;
  if (decision === null) return text('{}');
  const output: JsonObject = {
    hookEventName: 'PreToolUse',
    permissionDecision: decision,
    permissionDecisionReason:
      typeof entry.permissionDecisionReason === 'string'
        ? entry.permissionDecisionReason
        : `The probe gate answers ${decision}.`,
  };
  if (decision === 'allow' && isObject(entry.updatedInput)) {
    output.updatedInput = entry.updatedInput;
  }
  return text(JSON.stringify({ hookSpecificOutput: output }));
}

async function callTool(params: JsonObject, io: ProbeIo): Promise<JsonObject> {
  const args = isObject(params.arguments) ? params.arguments : {};
  if (params.name === 'slow_echo') {
    const seconds = args.seconds ?? 0;
    if (typeof args.text !== 'string') return text('slow_echo needs a text.', true);
    if (typeof seconds !== 'number' || !(seconds >= 0 && seconds <= MAX_SECONDS)) {
      return text(`slow_echo waits 0 to ${MAX_SECONDS} seconds.`, true);
    }
    await io.sleep(seconds * 1000);
    return text(args.text);
  }
  if (params.name === 'approve') {
    const toolName = typeof args.tool_name === 'string' ? args.tool_name : '';
    const input = isObject(args.input) ? args.input : {};
    const answer = decide(toolName, input, io.decisions());
    io.log({ mode: 'approve', tool_name: toolName, input, tool_use_id: args.tool_use_id, answer });
    return text(JSON.stringify(answer));
  }
  if (params.name === GATE_TOOL) {
    const answer = gateAnswer(args, io.gateDecisions?.() ?? {});
    io.log({ mode: 'gate', arguments: args, answer });
    return answer;
  }
  return text(`The probe has no tool named ${String(params.name)}.`, true);
}

/**
 * One JSON-RPC message in, its reply out: null for a notification, which
 * gets none. Pure apart from what `io` does.
 */
export async function handleRpc(message: unknown, io: ProbeIo): Promise<RpcReply | null> {
  if (!isObject(message) || typeof message.method !== 'string') {
    return isObject(message) && message.id !== undefined
      ? failure(message.id, -32600, 'Invalid request')
      : null;
  }
  const { id, method } = message;
  const params = isObject(message.params) ? message.params : {};
  if (id === undefined) return null;
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion:
          typeof params.protocolVersion === 'string' ? params.protocolVersion : FALLBACK_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: '1.0.0' },
      });
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS });
    case 'tools/call':
      return reply(id, await callTool(params, io));
    default:
      return failure(id, -32601, `Method not found: ${method}`);
  }
}

/** The PreToolUse hook's answer: the tool's entry in `decisions`, else allow. */
export function hookAnswer(input: unknown, decisions: JsonObject): JsonObject {
  const toolName = isObject(input) && typeof input.tool_name === 'string' ? input.tool_name : '';
  const entry = decisions[toolName];
  const decision =
    isObject(entry) && HOOK_DECISIONS.includes(String(entry.permissionDecision))
      ? String(entry.permissionDecision)
      : 'allow';
  const reason =
    isObject(entry) && typeof entry.permissionDecisionReason === 'string'
      ? entry.permissionDecisionReason
      : `The probe answers ${decision}.`;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
}

function readJson(path: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function fileIo(dir: string): ProbeIo {
  return {
    decisions: () => readJson(join(dir, 'decisions.json')),
    gateDecisions: () => readJson(join(dir, 'gate-decisions.json')),
    log: (entry) => appendFileSync(join(dir, 'log.jsonl'), `${JSON.stringify(entry)}\n`),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  };
}

function serve(io: ProbeIo): void {
  // Each line is handled on its own, so a ping answers while slow_echo waits.
  createInterface({ input: process.stdin }).on('line', (line) => {
    if (line.trim() === '') return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify(failure(null, -32700, 'Parse error'))}\n`);
      return;
    }
    void handleRpc(message, io).then((answer) => {
      if (answer) process.stdout.write(`${JSON.stringify(answer)}\n`);
    });
  });
}

function main(argv: string[]): void {
  const at = argv.indexOf('--dir');
  const dir = at === -1 ? undefined : argv[at + 1];
  if (!dir || (argv[0] !== 'server' && argv[0] !== 'hook')) {
    process.stderr.write('usage: probe.ts server|hook --dir <probe folder>\n');
    process.exit(2);
  }
  const io = fileIo(dir);
  if (argv[0] === 'server') {
    serve(io);
    return;
  }
  let input: unknown = null;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    // An unreadable input still gets an answer: the default allow.
  }
  const answer = hookAnswer(input, readJson(join(dir, 'hook-decisions.json')));
  io.log({ mode: 'hook', input, answer });
  process.stdout.write(`${JSON.stringify(answer)}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
